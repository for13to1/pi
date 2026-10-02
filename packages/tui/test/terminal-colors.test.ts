import assert from "node:assert";
import { describe, it } from "node:test";
import {
	type Component,
	parseTerminalColorSchemeReport,
	type Terminal,
	type TerminalColors,
	type TUI,
	TuiMainScreen,
} from "../src/index.ts";
import { parseOscColorResponse } from "../src/terminal-colors.ts";

class TestTerminal implements Terminal {
	private inputHandler?: (data: string) => void;
	private resizeHandler?: () => void;
	private readonly columnCount: number;
	private readonly rowCount: number;
	readonly writes: string[] = [];

	constructor(columnCount = 80, rowCount = 24) {
		this.columnCount = columnCount;
		this.rowCount = rowCount;
	}

	start(onInput: (data: string) => void, onResize: () => void): void {
		this.inputHandler = onInput;
		this.resizeHandler = onResize;
	}

	stop(): void {
		this.inputHandler = undefined;
		this.resizeHandler = undefined;
	}

	async drainInput(_maxMs?: number, _idleMs?: number): Promise<void> {}

	write(data: string): void {
		this.writes.push(data);
	}

	get columns(): number {
		return this.columnCount;
	}

	get rows(): number {
		return this.rowCount;
	}

	get kittyProtocolActive(): boolean {
		return false;
	}

	moveBy(_lines: number): void {}

	hideCursor(): void {}

	showCursor(): void {}

	clearLine(): void {}

	clearFromCursor(): void {}

	clearScreen(): void {}

	setTitle(_title: string): void {}

	setProgress(_active: boolean): void {}

	sendInput(data: string): void {
		this.inputHandler?.(data);
	}

	sendResize(): void {
		this.resizeHandler?.();
	}
}

class InputRecorder implements Component {
	readonly inputs: string[] = [];

	render(_width: number): string[] {
		return [];
	}

	handleInput(data: string): void {
		this.inputs.push(data);
	}

	invalidate(): void {}
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

describe("parseTerminalColorSchemeReport", () => {
	it("parses color scheme reports", () => {
		assert.strictEqual(parseTerminalColorSchemeReport("\x1b[?997;1n"), "dark");
		assert.strictEqual(parseTerminalColorSchemeReport("\x1b[?997;2n"), "light");
		assert.strictEqual(parseTerminalColorSchemeReport("\x1b[?997;2n\x1b[?997;1n\x1b[?997;1n"), "dark");
		assert.strictEqual(parseTerminalColorSchemeReport("\x1b[?997;1n\x1b[?997;2n\x1b[?997;2n"), "light");
		assert.strictEqual(parseTerminalColorSchemeReport("\x1b[?997;3n"), undefined);
		assert.strictEqual(parseTerminalColorSchemeReport("\x1b[?996n"), undefined);
		assert.strictEqual(parseTerminalColorSchemeReport("x\x1b[?997;1n"), undefined);
	});
});

describe("parseOscColorResponse", () => {
	it("parses OSC 10, 11, and 4 replies", () => {
		assert.deepStrictEqual(parseOscColorResponse("\x1b]10;rgb:ffff/ffff/ffff\x07"), {
			target: "foreground",
			rgb: { r: 255, g: 255, b: 255 },
		});
		assert.deepStrictEqual(parseOscColorResponse("\x1b]4;13;#ff0080\x1b\\"), {
			target: 13,
			rgb: { r: 255, g: 0, b: 128 },
		});
		assert.deepStrictEqual(parseOscColorResponse("\x1b]4;1;bogus\x07"), { target: 1, rgb: undefined });
		assert.strictEqual(parseOscColorResponse("\x1b]12;#ffffff\x07"), undefined);
	});
});

const PALETTE_REPLIES = Array.from({ length: 16 }, (_, index) => `\x1b]4;${index};#000000\x07`);
const DA1 = "\x1b[?62;22c";
const BLACK = { r: 0, g: 0, b: 0 };
const WHITE = { r: 255, g: 255, b: 255 };

function setup(): { terminal: TestTerminal; tui: TUI; component: InputRecorder } {
	const terminal = new TestTerminal();
	const tui: TUI = new TuiMainScreen(terminal);
	const component = new InputRecorder();
	tui.addChild(component);
	tui.setFocus(component);
	tui.start();
	return { terminal, tui, component };
}

describe("TUI.queryTerminalColors", () => {
	it("queries all colors in one write and consumes the replies", async () => {
		const { terminal, tui, component } = setup();
		try {
			const query = tui.queryTerminalColors({ timeoutMs: 1000, palette: true });
			const written = terminal.writes.at(-1) ?? "";
			assert.ok(written.startsWith("\x1b]10;?\x07\x1b]11;?\x07\x1b]4;0;?\x07") && written.endsWith("\x1b[c"));

			terminal.sendInput("x");
			terminal.sendInput("\x1b]10;#ffffff\x07");
			terminal.sendInput("\x1b]11;rgb:0000/0000/0000\x1b\\");
			for (const reply of PALETTE_REPLIES) terminal.sendInput(reply);
			// Resolves once every reply arrived, without waiting for DA1.
			assert.deepStrictEqual(await query, {
				foreground: WHITE,
				background: BLACK,
				palette: Array.from({ length: 16 }, () => BLACK),
			});
			terminal.sendInput(DA1);
			assert.deepStrictEqual(component.inputs, ["x"]);
		} finally {
			tui.stop();
		}
	});

	it("resolves on DA1 with the replies that arrived, in query order", async () => {
		const { terminal, tui } = setup();
		try {
			const first = tui.queryTerminalColors({ timeoutMs: 1000 });
			const second = tui.queryTerminalColors({ timeoutMs: 1000 });
			terminal.sendInput("\x1b]11;#000000\x07");
			// An incomplete palette is dropped.
			for (const reply of PALETTE_REPLIES.slice(0, 8)) terminal.sendInput(reply);
			terminal.sendInput(DA1);
			terminal.sendInput(DA1);

			assert.deepStrictEqual(await first, { foreground: undefined, background: BLACK, palette: undefined });
			assert.deepStrictEqual(await second, { foreground: undefined, background: undefined, palette: undefined });
		} finally {
			tui.stop();
		}
	});

	it("reports late replies after a timeout and keeps reading them past DA1", async () => {
		const { terminal, tui, component } = setup();
		try {
			const late: TerminalColors[] = [];
			const query = tui.queryTerminalColors({ timeoutMs: 1, onLateReply: (colors) => late.push(colors) });
			await wait(5);
			assert.strictEqual((await query).background, undefined);

			terminal.sendInput("\x1b]11;#ffffff\x07");
			terminal.sendInput(DA1);
			assert.deepStrictEqual(late, [{ foreground: undefined, background: WHITE, palette: undefined }]);
			assert.deepStrictEqual(component.inputs, []);

			// The reply outlived the query that asked for it, so it is still a reply, not typing.
			terminal.sendInput("\x1b]10;#ffffff\x07");
			assert.deepStrictEqual(component.inputs, []);

			// The window is bounded: once it closes, color replies are ordinary input again.
			await wait(300);
			terminal.sendInput("\x1b]11;#ffffff\x07");
			assert.deepStrictEqual(component.inputs, ["\x1b]11;#ffffff\x07"]);
		} finally {
			tui.stop();
		}
	});

	it("asks only for the default colors unless the caller asks for the palette", async () => {
		const { terminal, tui } = setup();
		try {
			const query = tui.queryTerminalColors({ timeoutMs: 100 });
			assert.strictEqual(terminal.writes.at(-1), "\x1b]10;?\x07\x1b]11;?\x07\x1b[c");

			terminal.sendInput("\x1b]10;#ffffff\x07");
			terminal.sendInput("\x1b]11;#000000\x07");
			assert.deepStrictEqual(await query, { foreground: WHITE, background: BLACK, palette: undefined });
		} finally {
			tui.stop();
		}
	});

	it("consumes a reply that arrives after the query ended", async () => {
		const { terminal, tui, component } = setup();
		try {
			tui.queryTerminalColors({ timeoutMs: 100 });
			// A terminal that answers DA1 before its color replies ends the query while they are still
			// on their way. They are replies, so they are consumed rather than typed.
			terminal.sendInput(DA1);
			terminal.sendInput("\x1b]10;#ffffff\x07");
			assert.deepStrictEqual(component.inputs, []);

			// Typing during the window is untouched. StdinBuffer hands input over one character at a
			// time, and nothing here is held back or dropped.
			for (const character of "abc") terminal.sendInput(character);
			assert.deepStrictEqual(component.inputs, ["a", "b", "c"]);
		} finally {
			tui.stop();
		}
	});

	it("delivers a reply that arrives after DA1 to onLateReply", async () => {
		const { terminal, tui } = setup();
		try {
			const late: TerminalColors[] = [];
			const query = tui.queryTerminalColors({ timeoutMs: 1000, onLateReply: (colors) => late.push(colors) });
			// DA1 ends the query while the color replies are still on their way, and they still have to
			// reach the theme rather than only being kept out of the editor.
			terminal.sendInput(DA1);
			assert.deepStrictEqual(await query, { foreground: undefined, background: undefined, palette: undefined });

			terminal.sendInput("\x1b]11;#000000\x07");
			assert.deepStrictEqual(late, [{ foreground: undefined, background: BLACK, palette: undefined }]);
		} finally {
			tui.stop();
		}
	});

	it("does not let a settled query swallow the next query's replies", async () => {
		const { terminal, tui } = setup();
		try {
			const first = tui.queryTerminalColors({ timeoutMs: 1000 });
			terminal.sendInput(DA1);
			await first;

			// The first query stays open to collect replies still on their way, but the replies that
			// follow the second query belong to the second query.
			const second = tui.queryTerminalColors({ timeoutMs: 1000 });
			terminal.sendInput("\x1b]10;#ffffff\x07");
			terminal.sendInput("\x1b]11;#000000\x07");
			assert.deepStrictEqual(await second, { foreground: WHITE, background: BLACK, palette: undefined });
		} finally {
			tui.stop();
		}
	});

	it("gives the replies after DA1 to the query that asked for them, with a later query waiting", async () => {
		const { terminal, tui } = setup();
		try {
			const late: TerminalColors[] = [];
			const first = tui.queryTerminalColors({ timeoutMs: 1000, onLateReply: (colors) => late.push(colors) });
			const second = tui.queryTerminalColors({ timeoutMs: 1000 });

			// A terminal that answers DA1 before its colors: the first query completes on the DA1, and the
			// colors that follow are still its own, not the second query's.
			terminal.sendInput(DA1);
			terminal.sendInput("\x1b]10;#ffffff\x07");
			terminal.sendInput("\x1b]11;#000000\x07");

			assert.deepStrictEqual(await first, { foreground: undefined, background: undefined, palette: undefined });
			assert.deepStrictEqual(late.at(-1), { foreground: WHITE, background: BLACK, palette: undefined });

			// The second query's own replies still complete it.
			terminal.sendInput("\x1b]10;#ffffff\x07");
			terminal.sendInput("\x1b]11;#000000\x07");
			assert.deepStrictEqual(await second, { foreground: WHITE, background: BLACK, palette: undefined });
		} finally {
			tui.stop();
		}
	});

	it("does not let a trailing DA1 complete the query that is still waiting", async () => {
		const { terminal, tui } = setup();
		try {
			const first = tui.queryTerminalColors({ timeoutMs: 1000 });
			const second = tui.queryTerminalColors({ timeoutMs: 1000 });

			// The usual order: colors, then DA1, then the next query's colors. The DA1 belongs to the
			// query that just finished.
			terminal.sendInput("\x1b]10;#ffffff\x07");
			terminal.sendInput("\x1b]11;#000000\x07");
			terminal.sendInput(DA1);

			const settled = await Promise.race([
				second.then((colors) => `settled ${JSON.stringify(colors)}`),
				wait(50).then(() => "still waiting"),
			]);
			assert.strictEqual(settled, "still waiting");
			assert.deepStrictEqual(await first, { foreground: WHITE, background: BLACK, palette: undefined });

			terminal.sendInput("\x1b]10;#ffffff\x07");
			terminal.sendInput("\x1b]11;#000000\x07");
			assert.deepStrictEqual(await second, { foreground: WHITE, background: BLACK, palette: undefined });
		} finally {
			tui.stop();
		}
	});

	it("does not complete a new query with the previous query's trailing DA1", async () => {
		const { terminal, tui } = setup();
		try {
			const first = tui.queryTerminalColors({ timeoutMs: 1000 });
			terminal.sendInput("\x1b]10;#ffffff\x07");
			terminal.sendInput("\x1b]11;#000000\x07");
			assert.deepStrictEqual(await first, { foreground: WHITE, background: BLACK, palette: undefined });

			// The first query has its colors but not its DA1 yet. A new query starts, and that trailing
			// DA1 belongs to the first query, so it must not settle the second.
			const second = tui.queryTerminalColors({ timeoutMs: 1000 });
			terminal.sendInput(DA1);
			const settled = await Promise.race([
				second.then((colors) => `settled ${JSON.stringify(colors)}`),
				wait(50).then(() => "still waiting"),
			]);
			assert.strictEqual(settled, "still waiting");

			terminal.sendInput("\x1b]10;#ffffff\x07");
			terminal.sendInput("\x1b]11;#000000\x07");
			assert.deepStrictEqual(await second, { foreground: WHITE, background: BLACK, palette: undefined });
		} finally {
			tui.stop();
		}
	});

	it("settles each of two queries that both answer DA1 before their colors", async () => {
		const { terminal, tui } = setup();
		try {
			const late: string[] = [];
			const describe = (colors: TerminalColors): string =>
				`${colors.foreground ? "fg" : "-"}${colors.background ? "bg" : "-"}`;
			const first = tui.queryTerminalColors({
				timeoutMs: 1000,
				onLateReply: (colors) => late.push(`first ${describe(colors)}`),
			});
			const second = tui.queryTerminalColors({
				timeoutMs: 1000,
				onLateReply: (colors) => late.push(`second ${describe(colors)}`),
			});

			// Each burst opens with its own DA1, so the second DA1 is the second query's, not a repeat of
			// the first query's.
			terminal.sendInput(DA1);
			terminal.sendInput(DA1);
			assert.deepStrictEqual(await first, { foreground: undefined, background: undefined, palette: undefined });
			assert.deepStrictEqual(await second, { foreground: undefined, background: undefined, palette: undefined });

			// The colors that follow are still each query's own.
			terminal.sendInput("\x1b]10;#ffffff\x07");
			terminal.sendInput("\x1b]11;#000000\x07");
			terminal.sendInput("\x1b]10;#ffffff\x07");
			terminal.sendInput("\x1b]11;#000000\x07");
			assert.deepStrictEqual(late, ["first fg-", "first fgbg", "second fg-", "second fgbg"]);
		} finally {
			tui.stop();
		}
	});

	it("does not let a query that timed out own a later query's replies while its window is still open", async () => {
		const { terminal, tui } = setup();
		try {
			const first = tui.queryTerminalColors({ timeoutMs: 20 });
			await first;
			// Still inside the first query's reply window, which is not what decides ownership.
			await wait(10);

			const second = tui.queryTerminalColors({ timeoutMs: 1000 });
			terminal.sendInput("\x1b]10;#ffffff\x07");
			terminal.sendInput("\x1b]11;#000000\x07");
			terminal.sendInput(DA1);
			const settled = await Promise.race([
				second.then((colors) => `settled ${JSON.stringify(colors)}`),
				wait(150).then(() => "still waiting"),
			]);
			assert.strictEqual(
				settled,
				`settled ${JSON.stringify({ foreground: WHITE, background: BLACK, palette: undefined })}`,
			);
		} finally {
			tui.stop();
		}
	});

	it("does not revive an expired query with a later query's window", async () => {
		const { terminal, tui } = setup();
		try {
			const first = tui.queryTerminalColors({ timeoutMs: 20 });
			await first;
			const second = tui.queryTerminalColors({ timeoutMs: 500 });
			await second;
			// Both are expired, but the second query's window is still open when the third starts.
			const third = tui.queryTerminalColors({ timeoutMs: 1000 });
			terminal.sendInput("\x1b]10;#ffffff\x07");
			terminal.sendInput("\x1b]11;#000000\x07");
			terminal.sendInput(DA1);
			const settled = await Promise.race([
				third.then((colors) => `settled ${JSON.stringify(colors)}`),
				wait(150).then(() => "still waiting"),
			]);
			assert.strictEqual(
				settled,
				`settled ${JSON.stringify({ foreground: WHITE, background: BLACK, palette: undefined })}`,
			);
		} finally {
			tui.stop();
		}
	});

	it("does not let a query that timed out and stopped waiting own a later query's replies", async () => {
		const { terminal, tui } = setup();
		try {
			const first = tui.queryTerminalColors({ timeoutMs: 20 });
			assert.deepStrictEqual(await first, { foreground: undefined, background: undefined, palette: undefined });
			// Past its own grace period, so nothing it was waiting for can still be on its way.
			await wait(400);

			const second = tui.queryTerminalColors({ timeoutMs: 1000 });
			terminal.sendInput("\x1b]10;#ffffff\x07");
			terminal.sendInput("\x1b]11;#000000\x07");
			terminal.sendInput(DA1);
			assert.deepStrictEqual(await second, { foreground: WHITE, background: BLACK, palette: undefined });
		} finally {
			tui.stop();
		}
	});

	it("starts the replacing query with the colors the previous one already collected", async () => {
		const { terminal, tui } = setup();
		try {
			const first = tui.queryTerminalColors({ timeoutMs: 1000 });
			terminal.sendInput("\x1b]10;#ffffff\x07");
			terminal.sendInput(DA1);
			assert.deepStrictEqual(await first, { foreground: WHITE, background: undefined, palette: undefined });

			// The new query takes over the rest of the first query's burst, and it starts with what that
			// burst already delivered: it asks the same question, so the foreground is its answer too.
			// Without that it would resolve with half an answer, or wait for its timeout to do so.
			const second = tui.queryTerminalColors({ timeoutMs: 1000 });
			terminal.sendInput("\x1b]11;#000000\x07");
			assert.deepStrictEqual(await second, { foreground: WHITE, background: BLACK, palette: undefined });
		} finally {
			tui.stop();
		}
	});

	it("hands a superseded query's outstanding replies to the query that replaced it", async () => {
		const { terminal, tui } = setup();
		try {
			const late: TerminalColors[] = [];
			const first = tui.queryTerminalColors({ timeoutMs: 1000, onLateReply: (colors) => late.push(colors) });
			terminal.sendInput(DA1);
			assert.deepStrictEqual(await first, { foreground: undefined, background: undefined, palette: undefined });

			// Starting a new query takes over the replies that follow, including the ones the first query
			// was still waiting for. This is the trade the takeover makes: the superseded query does not
			// get them, and the new one asks the same question, so the same values arrive through it.
			const second = tui.queryTerminalColors({ timeoutMs: 1000 });
			terminal.sendInput("\x1b]10;#ffffff\x07");
			terminal.sendInput("\x1b]11;#000000\x07");
			assert.deepStrictEqual(late, []);
			assert.deepStrictEqual(await second, { foreground: WHITE, background: BLACK, palette: undefined });
		} finally {
			tui.stop();
		}
	});

	it("answers two outstanding queries in order, and gives the early one its colors late", async () => {
		const { terminal, tui } = setup();
		try {
			const late: TerminalColors[] = [];
			const first = tui.queryTerminalColors({ timeoutMs: 200 });
			// A shorter timeout than the query before it: this one gives up before its turn comes.
			const second = tui.queryTerminalColors({ timeoutMs: 30, onLateReply: (colors) => late.push(colors) });
			assert.deepStrictEqual(await second, { foreground: undefined, background: undefined, palette: undefined });

			// The terminal answers in order, so this burst is the first query's.
			terminal.sendInput("\x1b]10;#ffffff\x07");
			terminal.sendInput("\x1b]11;#000000\x07");
			terminal.sendInput(DA1);
			assert.deepStrictEqual(await first, { foreground: WHITE, background: BLACK, palette: undefined });

			// And this one is the second query's, which already settled. Nothing is lost: it arrives
			// through the channel for replies that come after a query settled.
			terminal.sendInput("\x1b]10;#ffffff\x07");
			terminal.sendInput("\x1b]11;#000000\x07");
			assert.deepStrictEqual(late.at(-1), { foreground: WHITE, background: BLACK, palette: undefined });
		} finally {
			tui.stop();
		}
	});

	it("settles each query on its own timeout when the timeouts differ", async () => {
		const { tui } = setup();
		try {
			const settled: string[] = [];
			const first = tui.queryTerminalColors({ timeoutMs: 150 }).then(() => settled.push("first"));
			const second = tui.queryTerminalColors({ timeoutMs: 20 }).then(() => settled.push("second"));

			// The later, shorter query has to settle on its own timer. Settling the oldest query instead
			// resolves the wrong promise and leaves this one with no timer left to resolve it.
			await Promise.race([second, wait(200).then(() => assert.fail("the second query never settled"))]);
			assert.deepStrictEqual(settled, ["second"]);

			await first;
			assert.deepStrictEqual(settled, ["second", "first"]);
		} finally {
			tui.stop();
		}
	});

	it("completes two overlapping queries from their own replies", async () => {
		const { terminal, tui } = setup();
		try {
			const first = tui.queryTerminalColors({ timeoutMs: 1000 });
			const second = tui.queryTerminalColors({ timeoutMs: 1000 });
			// Both bursts arrive back to back; the first query completes in the middle of them.
			terminal.sendInput("\x1b]10;#ffffff\x07");
			terminal.sendInput("\x1b]11;#000000\x07");
			terminal.sendInput("\x1b]10;#ffffff\x07");
			terminal.sendInput("\x1b]11;#000000\x07");

			assert.deepStrictEqual(await first, { foreground: WHITE, background: BLACK, palette: undefined });
			assert.deepStrictEqual(await second, { foreground: WHITE, background: BLACK, palette: undefined });
		} finally {
			tui.stop();
		}
	});
});
