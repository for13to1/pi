import type { TerminalColors, TUI } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SettingsManager } from "../src/core/settings-manager.ts";
import {
	initTheme,
	setTerminalColorScheme,
	setTerminalColors,
	type TerminalTheme,
	theme,
} from "../src/modes/interactive/theme/theme.ts";
import {
	InteractiveThemeController,
	resolveTerminalColorQuery,
	shouldQueryTerminalPalette,
	type TmuxProbe,
} from "../src/modes/interactive/theme/theme-controller.ts";

const DARK: TerminalColors = { foreground: { r: 248, g: 248, b: 242 }, background: { r: 40, g: 42, b: 54 } };
const LIGHT: TerminalColors = { foreground: { r: 30, g: 30, b: 30 }, background: { r: 250, g: 250, b: 250 } };

type ColorQueryOptions = { timeoutMs: number; onLateReply?: (colors: TerminalColors) => void; palette?: boolean };

function createUi() {
	const queryTerminalColors = vi.fn(async (_options: ColorQueryOptions): Promise<TerminalColors> => ({}));
	const setTerminalColorSchemeNotifications = vi.fn();
	let terminalColorSchemeListener: ((terminalTheme: TerminalTheme) => void) | undefined;
	const unsubscribeTerminalColorScheme = vi.fn();
	const ui = {
		invalidate: vi.fn(),
		requestRender: vi.fn(),
		setTerminalColorSchemeNotifications,
		onTerminalColorSchemeChange: vi.fn((listener: (terminalTheme: TerminalTheme) => void) => {
			terminalColorSchemeListener = listener;
			return unsubscribeTerminalColorScheme;
		}),
		queryTerminalColors,
	} as unknown as TUI;
	return {
		ui,
		queryTerminalColors,
		setTerminalColorSchemeNotifications,
		unsubscribeTerminalColorScheme,
		emitTerminalColorScheme: (terminalTheme: TerminalTheme) => terminalColorSchemeListener?.(terminalTheme),
	};
}

function createController(ui: TUI, getSettingsManager: () => SettingsManager, initialThemeSetting?: string) {
	return new InteractiveThemeController(ui, {
		getSettingsManager,
		showError: vi.fn(),
		onChanged: vi.fn(),
		initialThemeSetting,
	});
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
	// The controller tests exercise the default palette path, where resolveTerminalColorQuery probes for tmux.
	// Removing TMUX from the environment keeps that deterministic: the probe reports no tmux and the palette
	// stays on, the same result as on CI, rather than depending on the developer's tmux.
	vi.stubEnv("TMUX", undefined);
});

afterEach(() => {
	setTerminalColors({});
	setTerminalColorScheme(undefined);
	initTheme("dark");
	vi.unstubAllEnvs();
});

/** A probe for a tmux that reported `version`. */
const tmux = (version: string): TmuxProbe => ({ kind: "version", version });

describe("shouldQueryTerminalPalette", () => {
	it("asks when no relay is in the path", () => {
		// No tmux at all, and tmux versions that answered the palette query themselves.
		expect(shouldQueryTerminalPalette({ kind: "outside" })).toBe(true);
		// 3.7 fixed how relayed replies are handled.
		expect(shouldQueryTerminalPalette(tmux("3.7"))).toBe(true);
		expect(shouldQueryTerminalPalette(tmux("3.7b"))).toBe(true);
		expect(shouldQueryTerminalPalette(tmux("4.0"))).toBe(true);
	});

	it("does not ask on 3.6.x, which relays the palette query (issue #10250)", () => {
		// tmux issue 4665 added the OSC 4 relay in 3.6, and tmux issues 4749 and 4793 are the reports behind
		// the two fixes in 3.7, so the window is exactly 3.6 <= v < 3.7. See the tmux CHANGES from 3.6 to
		// 3.6b and from 3.6b to 3.7.
		expect(shouldQueryTerminalPalette(tmux("3.6"))).toBe(false);
		expect(shouldQueryTerminalPalette(tmux("3.6a"))).toBe(false);
		expect(shouldQueryTerminalPalette(tmux("3.6b"))).toBe(false);
	});

	it("keeps the palette on 3.4 and 3.5, which never forwarded the palette query", () => {
		// Before 3.6 tmux answered OSC 4 itself, so there is nothing to leak and no reason to skip it.
		expect(shouldQueryTerminalPalette(tmux("3.4"))).toBe(true);
		expect(shouldQueryTerminalPalette(tmux("3.5"))).toBe(true);
		expect(shouldQueryTerminalPalette(tmux("3.5a"))).toBe(true);
	});

	it("keeps asking when tmux reported a version we cannot parse", () => {
		// tmux answered, so this is a development build rather than an unknown 3.6.x: a future tmux that
		// reports something unexpected keeps its palette rather than losing it.
		expect(shouldQueryTerminalPalette(tmux("next-4"))).toBe(true);
		expect(shouldQueryTerminalPalette(tmux("master"))).toBe(true);
	});

	it("fails safe when tmux is in the path but did not answer", () => {
		// A failed probe must not re-expose the bug: the relay only exists inside tmux, and what leaks is the
		// reported garbage. Losing the palette costs colors only.
		expect(shouldQueryTerminalPalette({ kind: "unreadable" })).toBe(false);
	});
});

describe("resolveTerminalColorQuery", () => {
	it("skips the palette only on the tmux versions that relay it", () => {
		expect(resolveTerminalColorQuery(SettingsManager.inMemory(), tmux("3.6"))).toEqual({
			enabled: true,
			palette: false,
		});
		expect(resolveTerminalColorQuery(SettingsManager.inMemory(), tmux("3.7"))).toEqual({
			enabled: true,
			palette: true,
		});
	});

	it("skips the palette when the tmux version is unreadable", () => {
		expect(resolveTerminalColorQuery(SettingsManager.inMemory(), { kind: "unreadable" })).toEqual({
			enabled: true,
			palette: false,
		});
	});

	it("lets the settings decide", () => {
		const configured = SettingsManager.inMemory({ terminal: { queryPalette: true } });
		expect(resolveTerminalColorQuery(configured, tmux("3.6"))).toEqual({ enabled: true, palette: true });
		expect(resolveTerminalColorQuery(configured, { kind: "unreadable" })).toEqual({ enabled: true, palette: true });

		// `palette` is unused when the query is off, but it still resolves rather than being forced.
		const off = SettingsManager.inMemory({ terminal: { queryColors: false } });
		expect(resolveTerminalColorQuery(off, tmux("3.7"))).toEqual({ enabled: false, palette: true });
	});
});

describe("InteractiveThemeController", () => {
	it("uses the initial theme without persisting it", async () => {
		const { ui, queryTerminalColors } = createUi();
		const manager = SettingsManager.inMemory({ theme: "dark" });
		const setTheme = vi.spyOn(manager, "setTheme");
		const flushSettings = vi.spyOn(manager, "flush");
		const controller = createController(ui, () => manager, "light");

		expect(theme.name).toBe("light");
		expect(controller.getThemeSelection()).toBe("light");
		controller.applyFromSettings();
		await flush();

		expect(queryTerminalColors).toHaveBeenCalledOnce();
		expect(setTheme).not.toHaveBeenCalled();
		expect(flushSettings).not.toHaveBeenCalled();
	});

	it("asks for nothing when terminal.queryColors is false", async () => {
		const { ui, queryTerminalColors } = createUi();
		const controller = createController(ui, () => SettingsManager.inMemory({ terminal: { queryColors: false } }));
		controller.applyFromSettings();
		await flush();

		expect(queryTerminalColors).not.toHaveBeenCalled();
		// The pending state still clears, so the theme falls back to indices instead of staying grayscale.
		expect(theme.getFgAnsi("error")).toBe("\x1b[38;5;1m");
	});

	it("passes the resolved palette choice to the query", async () => {
		// tmux 3.6.x relays OSC 4 and can leak the reply into the editor as typing (issue #10250), so the
		// palette query is off there. Observed by hand on tmux 3.6 with a fragmented outer-terminal reply;
		// the leak needs specific terminal timing, so the reproduction is manual rather than a test.
		const { ui, queryTerminalColors } = createUi();
		const controller = createController(ui, () => SettingsManager.inMemory({ terminal: { queryPalette: false } }));
		controller.applyFromSettings();
		await flush();

		expect(queryTerminalColors).toHaveBeenCalledOnce();
		expect(queryTerminalColors.mock.calls[0]![0]).toMatchObject({ palette: false });
	});

	it("applies the theme immediately and lets startup wait for the colors", async () => {
		const { ui, queryTerminalColors } = createUi();
		let answer: (colors: TerminalColors) => void = () => {};
		queryTerminalColors.mockReturnValue(
			new Promise((resolve) => {
				answer = resolve;
			}),
		);
		const controller = createController(ui, () => SettingsManager.inMemory());
		controller.applyFromSettings();

		// Grayscale until the terminal answers.
		expect(theme.name).toBe("system");
		expect(theme.getFgAnsi("error")).toBe("\x1b[39m");

		answer(DARK);
		await controller.waitForTerminalColors();
		expect(theme.getFgAnsi("error")).toMatch(/^\x1b\[38;/);
	});

	it("falls back to palette indices, then applies colors that arrive after the timeout", async () => {
		const { ui, queryTerminalColors } = createUi();
		let lateReply: (colors: TerminalColors) => void = () => {};
		queryTerminalColors.mockImplementation(async (options) => {
			lateReply = options.onLateReply!;
			return {};
		});
		const controller = createController(ui, () => SettingsManager.inMemory());
		controller.applyFromSettings();
		await flush();
		expect(theme.getFgAnsi("error")).toBe("\x1b[38;5;1m");

		lateReply(DARK);
		expect(theme.colors.error.kind).toBe("rgb");
	});

	it("re-queries the colors on appearance changes and lets them decide", async () => {
		const { ui, queryTerminalColors, setTerminalColorSchemeNotifications, emitTerminalColorScheme } = createUi();
		queryTerminalColors.mockResolvedValue(LIGHT);
		const controller = createController(ui, () => SettingsManager.inMemory(), "light/dark");
		controller.applyFromSettings();
		expect(setTerminalColorSchemeNotifications).toHaveBeenCalledWith(true);
		await flush();
		expect(theme.name).toBe("light");

		queryTerminalColors.mockResolvedValue(DARK);
		// The report says light, but the terminal renders dark.
		emitTerminalColorScheme("light");
		await flush();
		expect(theme.name).toBe("dark");
	});

	it("uses the reported scheme for the system theme when the terminal reports no colors", async () => {
		vi.stubEnv("COLORFGBG", "");
		const { ui, emitTerminalColorScheme } = createUi();
		const controller = createController(ui, () => SettingsManager.inMemory());
		controller.applyFromSettings();
		await flush();
		expect(theme.appearance).toBe("dark");

		emitTerminalColorScheme("light");
		expect(theme.appearance).toBe("light");
		expect(controller.getTerminalTheme()).toBe("light");
	});

	it("re-renders only when the reported colors change", async () => {
		const { ui, queryTerminalColors } = createUi();
		const controller = createController(ui, () => SettingsManager.inMemory({ theme: "dark" }));
		const query = async (colors: TerminalColors) => {
			queryTerminalColors.mockResolvedValue(colors);
			controller.applyFromSettings();
			await flush();
		};

		await query(DARK);
		// A timeout keeps the known colors; erasing them would count as a change and re-render.
		await query({});
		await query(structuredClone(DARK));
		expect(ui.requestRender).toHaveBeenCalledOnce();
	});

	it("disables terminal appearance updates when disposed", async () => {
		const { ui, setTerminalColorSchemeNotifications, unsubscribeTerminalColorScheme } = createUi();
		const controller = createController(ui, () => SettingsManager.inMemory({ theme: "light/dark" }));
		controller.applyFromSettings();
		await flush();

		controller.dispose();

		expect(setTerminalColorSchemeNotifications).toHaveBeenLastCalledWith(false);
		expect(unsubscribeTerminalColorScheme).toHaveBeenCalledOnce();
	});

	it("lets an explicit selection replace the initial theme", async () => {
		const { ui } = createUi();
		const firstManager = SettingsManager.inMemory({ theme: "dark" });
		const secondManager = SettingsManager.inMemory({ theme: "light" });
		let manager = firstManager;
		const controller = createController(ui, () => manager, "light");
		controller.applyFromSettings();

		expect(controller.setThemeName("dark")).toEqual({ success: true });
		manager = secondManager;
		controller.applyFromSettings();
		await flush();

		expect(controller.getThemeSelection()).toBe("dark");
		expect(theme.name).toBe("dark");
	});

	it("reloads theme settings when no initial theme was supplied", async () => {
		const { ui } = createUi();
		const firstManager = SettingsManager.inMemory({ theme: "dark" });
		const secondManager = SettingsManager.inMemory({ theme: "light" });
		let manager = firstManager;
		const controller = createController(ui, () => manager);
		controller.applyFromSettings();

		firstManager.applyOverrides({ theme: "light" });
		controller.applyFromSettings();
		expect(theme.name).toBe("light");

		secondManager.applyOverrides({ theme: "dark" });
		manager = secondManager;
		controller.applyFromSettings();
		expect(theme.name).toBe("dark");
	});
});
