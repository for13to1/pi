import { execFileSync } from "node:child_process";
import type { RgbColor, TerminalColors, TUI } from "@earendil-works/pi-tui";
import type { SettingsManager } from "../../../core/settings-manager.ts";
import {
	getTerminalTheme,
	initTheme,
	markTerminalColorsPending,
	parseAutoThemeSetting,
	resolveThemeSetting,
	SYSTEM_THEME_NAME,
	setTerminalColorScheme,
	setTerminalColors,
	setTheme,
	setThemeInstance,
	type TerminalTheme,
	type Theme,
} from "./theme.ts";

type ThemeResult = { success: boolean; error?: string };

/**
 * How long the system theme stays grayscale before falling back to palette indices. Terminals answer
 * the trailing DA1 request right after the color replies, so this only matters for terminals that
 * answer neither. Replies arriving later still apply.
 */
const TERMINAL_QUERY_TIMEOUT_MS = 100;

/**
 * What the tmux probe found. `outside` means no tmux sits on this path, so nothing can relay the palette query;
 * `unreadable` means tmux is there but its version could not be read.
 */
export type TmuxProbe = { kind: "outside" } | { kind: "unreadable" } | { kind: "version"; version: string };

/**
 * Whether pi asks for the terminal's 16 ANSI palette colors. Skipped on tmux 3.6.x, which relays an OSC 4 palette
 * query to the outer terminal and can misread a split relayed reply as typing in the editor. tmux issue 4665 added
 * that relay in 3.6; tmux issues 4749 and 4793 are the reports behind the two fixes in 3.7. The relay does not
 * exist before 3.6, so 3.4 and 3.5 keep the palette, and a version tmux reported but we cannot parse is left alone
 * too.
 *
 * An unreadable version inside tmux fails safe. The relay only exists on that path, what leaks is the reported
 * bug, and dropping the palette costs colors only. Outside tmux there is nothing to relay.
 */
export function shouldQueryTerminalPalette(probe: TmuxProbe): boolean {
	if (probe.kind === "outside") {
		return true;
	}
	if (probe.kind === "unreadable") {
		return false;
	}
	const match = probe.version.match(/^(\d+)\.(\d+)/);
	return match == null || !(Number(match[1]) === 3 && Number(match[2]) === 6);
}

let tmuxProbeCache: TmuxProbe | undefined;

/** Whether tmux is on this path, with its server version when tmux answers. Probed once. Synchronous, blocks at most 250 ms. */
function probeTmux(): TmuxProbe {
	if (tmuxProbeCache) {
		return tmuxProbeCache;
	}
	let probe: TmuxProbe = { kind: "outside" };
	if (process.env.TMUX !== undefined) {
		try {
			const version = execFileSync("tmux", ["display-message", "-p", "#{version}"], {
				encoding: "utf8",
				timeout: 250,
				stdio: ["ignore", "pipe", "ignore"],
			}).trim();
			probe = version === "" ? { kind: "unreadable" } : { kind: "version", version };
		} catch {
			// tmux is on this path but did not answer, so its version stays unknown.
			probe = { kind: "unreadable" };
		}
	}
	tmuxProbeCache = probe;
	return probe;
}

/** What the next color query asks for. */
export interface TerminalColorQuery {
	/** Whether to query at all: `terminal.queryColors`. */
	enabled: boolean;
	/** Whether to include the 16 ANSI palette colors: `terminal.queryPalette`. */
	palette: boolean;
}

/**
 * Resolve the query for a settings manager and this process. `terminal.queryPalette` overrides the probe, and a
 * configured value needs no probe, so the subprocess only runs when the decision is ours. `probe` is for tests.
 */
export function resolveTerminalColorQuery(settingsManager: SettingsManager, probe?: TmuxProbe): TerminalColorQuery {
	const configured = settingsManager.getTerminalQueryPalette();
	return {
		enabled: settingsManager.getTerminalQueryColors(),
		palette: configured ?? shouldQueryTerminalPalette(probe ?? probeTmux()),
	};
}

/**
 * Query the terminal's colors and pass them to `apply`, once the query settles and again for replies that
 * arrive after it. A failed query applies no colors. Asks for nothing when `query.enabled` is false.
 */
export function requestTerminalColors(
	ui: TUI,
	apply: (colors: TerminalColors) => void,
	query: TerminalColorQuery,
): Promise<void> {
	if (!query.enabled) {
		// Clears the pending state too, so the theme falls back to indices instead of staying grayscale.
		apply({});
		return Promise.resolve();
	}
	let pending: Promise<TerminalColors>;
	try {
		pending = ui.queryTerminalColors({
			timeoutMs: TERMINAL_QUERY_TIMEOUT_MS,
			onLateReply: apply,
			palette: query.palette,
		});
	} catch {
		pending = Promise.resolve({});
	}
	return pending.then(apply, () => apply({}));
}

function sameRgb(a: RgbColor | undefined, b: RgbColor | undefined): boolean {
	return a === b || (a !== undefined && b !== undefined && a.r === b.r && a.g === b.g && a.b === b.b);
}

function sameTerminalColors(a: TerminalColors, b: TerminalColors): boolean {
	if (!sameRgb(a.foreground, b.foreground) || !sameRgb(a.background, b.background)) return false;
	if (a.palette === b.palette) return true;
	if (!a.palette || !b.palette || a.palette.length !== b.palette.length) return false;
	return a.palette.every((color, index) => sameRgb(color, b.palette?.[index]));
}

/**
 * Applies the theme setting and keeps it in sync with the terminal. The theme applies immediately, and the
 * terminal's colors update it when they arrive; the system theme renders in grayscale until then. Callers
 * that bake theme colors into content can wait for the colors with `waitForTerminalColors()`.
 */
export class InteractiveThemeController {
	private readonly ui: TUI;
	private readonly getSettingsManager: () => SettingsManager;
	private readonly showError: (message: string) => void;
	private readonly onChanged: () => void;
	private currentThemeSetting: string | undefined;
	// Last reported colors; a query that times out keeps them instead of erasing them.
	private terminalColors: TerminalColors | undefined;
	private activeThemeName: string | undefined;
	private autoSyncEnabled = false;
	private terminalColorSchemeUnsubscribe: (() => void) | undefined;
	// Settles when the latest color query completed or timed out, and its colors applied.
	private terminalColorQuery: Promise<void> = Promise.resolve();

	constructor(
		ui: TUI,
		options: {
			getSettingsManager: () => SettingsManager;
			showError: (message: string) => void;
			onChanged: () => void;
			initialThemeSetting?: string;
		},
	) {
		this.ui = ui;
		this.getSettingsManager = options.getSettingsManager;
		this.showError = options.showError;
		this.onChanged = options.onChanged;
		this.currentThemeSetting = options.initialThemeSetting;
		this.activeThemeName = this.resolveThemeName();
		// The system theme starts in grayscale; color follows once the terminal reports its colors.
		markTerminalColorsPending();
		initTheme(this.activeThemeName, true);
		this.bindTerminalColorSchemeListener();
	}

	rebindTui(): void {
		this.terminalColorSchemeUnsubscribe?.();
		this.bindTerminalColorSchemeListener();
		this.ui.setTerminalColorSchemeNotifications(this.autoSyncEnabled);
	}

	/**
	 * Apply the theme setting now and query the terminal's colors, which update the theme when they arrive.
	 * Theme pairs and the system theme follow terminal appearance changes.
	 */
	applyFromSettings(): void {
		const themeSetting = this.getThemeSetting();
		const themeName = this.resolveThemeName();
		this.setAutoSync(parseAutoThemeSetting(themeSetting) !== undefined || themeName === SYSTEM_THEME_NAME);
		this.applyThemeName(themeName, themeSetting !== undefined);
		this.queryTerminalColors();
	}

	/**
	 * Wait until the latest color query completed or timed out. Content that bakes theme colors into
	 * strings, such as the startup header, should be built after this. Terminals answer the DA1 request
	 * right after the color replies, so this only takes the full timeout when a terminal answers nothing.
	 */
	waitForTerminalColors(): Promise<void> {
		return this.terminalColorQuery;
	}

	getThemeSelection(): string | undefined {
		return this.currentThemeSetting ?? this.getSettingsManager().getThemeSetting() ?? this.activeThemeName;
	}

	setThemeName(themeName: string, showError = false): ThemeResult {
		this.setAutoSync(themeName === SYSTEM_THEME_NAME);
		const result = this.applyThemeName(themeName, showError);
		if (result.success) {
			this.currentThemeSetting = themeName;
		}
		return result;
	}

	setThemeSetting(themeSetting: string): void {
		this.currentThemeSetting = themeSetting;
		this.applyFromSettings();
	}

	setThemeInstance(themeInstance: Theme): ThemeResult {
		this.setAutoSync(false);
		setThemeInstance(themeInstance);
		this.activeThemeName = "<in-memory>";
		this.notifyChanged();
		return { success: true };
	}

	preview(themeSettingOrName: string): void {
		const themeName = resolveThemeSetting(themeSettingOrName, getTerminalTheme()) ?? this.activeThemeName;
		if (!themeName) return;
		if (setTheme(themeName, true).success) {
			this.ui.invalidate();
			this.ui.requestRender();
		}
	}

	disableAutoSync(): void {
		this.setAutoSync(false);
	}

	dispose(): void {
		this.setAutoSync(false);
		this.terminalColorSchemeUnsubscribe?.();
		this.terminalColorSchemeUnsubscribe = undefined;
	}

	getTerminalTheme(): TerminalTheme {
		return getTerminalTheme();
	}

	private getThemeSetting(): string | undefined {
		return this.currentThemeSetting ?? this.getSettingsManager().getThemeSetting();
	}

	/** The theme for the current setting and terminal appearance. Without a setting, pi uses the system theme. */
	private resolveThemeName(): string {
		return resolveThemeSetting(this.getThemeSetting(), getTerminalTheme()) ?? SYSTEM_THEME_NAME;
	}

	private applyThemeName(themeName: string, showError = false): ThemeResult {
		const result = setTheme(themeName, true);
		this.activeThemeName = result.success ? themeName : SYSTEM_THEME_NAME;
		this.notifyChanged();
		if (!result.success && showError) {
			this.showError(`Failed to load theme "${themeName}": ${result.error}\nFell back to the system theme.`);
		}
		return result;
	}

	/** Query the terminal's colors without waiting for them; `waitForTerminalColors()` waits for this query. */
	private queryTerminalColors(): void {
		this.terminalColorQuery = requestTerminalColors(
			this.ui,
			(colors) => this.applyTerminalColors(colors),
			resolveTerminalColorQuery(this.getSettingsManager()),
		);
	}

	/**
	 * Record reported colors: themes use the default colors for tokens set to "", the system theme is
	 * generated from all of them, and light/dark detection uses them. Re-renders only when they changed.
	 */
	private applyTerminalColors(reported: TerminalColors): void {
		const previous = this.terminalColors;
		const next: TerminalColors = {
			foreground: reported.foreground ?? previous?.foreground,
			background: reported.background ?? previous?.background,
			palette: reported.palette ?? previous?.palette,
		};
		// Re-rendering rebuilds every component, so skip it when nothing changed (including timeouts).
		if (previous && sameTerminalColors(previous, next)) return;
		this.terminalColors = next;
		setTerminalColors(next);
		this.reapplyForTerminal();
		this.ui.invalidate();
		this.ui.requestRender();
	}

	/**
	 * Re-apply the setting after the terminal's colors or appearance changed: regenerate the system theme,
	 * or switch the theme of a pair. Themes set through extensions or previews are left alone.
	 */
	private reapplyForTerminal(): void {
		if (this.activeThemeName === "<in-memory>") return;
		const themeName = this.resolveThemeName();
		if (themeName === SYSTEM_THEME_NAME || themeName !== this.activeThemeName) {
			this.applyThemeName(themeName);
		}
	}

	private setAutoSync(enabled: boolean): void {
		if (this.autoSyncEnabled === enabled) return;
		this.autoSyncEnabled = enabled;
		this.ui.setTerminalColorSchemeNotifications(enabled);
	}

	private bindTerminalColorSchemeListener(): void {
		this.terminalColorSchemeUnsubscribe = this.ui.onTerminalColorSchemeChange((terminalTheme) =>
			this.applyTerminalColorSchemeChange(terminalTheme),
		);
	}

	/**
	 * The terminal reported a light/dark switch. Its colors changed too, so query them again: they decide
	 * the appearance. The reported scheme only matters for terminals that do not report their background.
	 */
	private applyTerminalColorSchemeChange(terminalTheme: TerminalTheme): void {
		if (!this.autoSyncEnabled) return;
		const previous = getTerminalTheme();
		setTerminalColorScheme(terminalTheme);
		if (getTerminalTheme() !== previous) this.reapplyForTerminal();
		this.queryTerminalColors();
	}

	private notifyChanged(): void {
		this.ui.invalidate();
		this.onChanged();
	}
}
