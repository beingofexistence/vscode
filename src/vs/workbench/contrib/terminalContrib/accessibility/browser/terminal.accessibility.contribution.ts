/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { KeyCode, KeyMod } from 'vs/base/common/keyCodes';
import { Disposable, DisposableStore, IDisposable, MutableDisposable } from 'vs/base/common/lifecycle';
import { localize } from 'vs/nls';
import { CONTEXT_ACCESSIBILITY_MODE_ENABLED } from 'vs/platform/accessibility/common/accessibility';
import { Action2, registerAction2 } from 'vs/platform/actions/common/actions';
import { ContextKeyExpr, IContextKeyService } from 'vs/platform/contextkey/common/contextkey';
import { IInstantiationService, ServicesAccessor } from 'vs/platform/instantiation/common/instantiation';
import { KeybindingWeight } from 'vs/platform/keybinding/common/keybindingsRegistry';
import { ITerminalCommand, TerminalCapability } from 'vs/platform/terminal/common/capabilities/capabilities';
import { ICurrentPartialCommand } from 'vs/platform/terminal/common/capabilities/commandDetectionCapability';
import { AccessibleViewProviderId, accessibleViewCurrentProviderId, accessibleViewIsShown } from 'vs/workbench/contrib/accessibility/browser/accessibilityConfiguration';
import { IAccessibleViewService, NavigationType } from 'vs/workbench/contrib/accessibility/browser/accessibleView';
import { AccessibilityHelpAction, AccessibleViewAction } from 'vs/workbench/contrib/accessibility/browser/accessibleViewActions';
import { ITerminalContribution, ITerminalInstance, ITerminalService, IXtermTerminal } from 'vs/workbench/contrib/terminal/browser/terminal';
import { registerTerminalAction } from 'vs/workbench/contrib/terminal/browser/terminalActions';
import { registerTerminalContribution } from 'vs/workbench/contrib/terminal/browser/terminalExtensions';
import { TerminalWidgetManager } from 'vs/workbench/contrib/terminal/browser/widgets/widgetManager';
import { ITerminalProcessManager, TerminalCommandId } from 'vs/workbench/contrib/terminal/common/terminal';
import { TerminalContextKeys } from 'vs/workbench/contrib/terminal/common/terminalContextKey';
import { BufferContentTracker } from 'vs/workbench/contrib/terminalContrib/accessibility/browser/bufferContentTracker';
import { TerminalAccessibilityHelpProvider } from 'vs/workbench/contrib/terminalContrib/accessibility/browser/terminalAccessibilityHelp';
import { TextAreaSyncAddon } from 'vs/workbench/contrib/terminalContrib/accessibility/browser/textAreaSyncAddon';
import type { Terminal } from '@xterm/xterm';
import { Position } from 'vs/editor/common/core/position';
import { ICommandWithEditorLine, TerminalAccessibleBufferProvider } from 'vs/workbench/contrib/terminalContrib/accessibility/browser/terminalAccessibleBufferProvider';
import { IConfigurationService } from 'vs/platform/configuration/common/configuration';
import { TerminalSettingId } from 'vs/platform/terminal/common/terminal';
import { Event } from 'vs/base/common/event';

class TextAreaSyncContribution extends DisposableStore implements ITerminalContribution {
	static readonly ID = 'terminal.textAreaSync';
	static get(instance: ITerminalInstance): TextAreaSyncContribution | null {
		return instance.getContribution<TextAreaSyncContribution>(TextAreaSyncContribution.ID);
	}
	private _addon: TextAreaSyncAddon | undefined;
	constructor(
		private readonly _instance: ITerminalInstance,
		processManager: ITerminalProcessManager,
		widgetManager: TerminalWidgetManager,
		@IInstantiationService private readonly _instantiationService: IInstantiationService
	) {
		super();
	}
	layout(xterm: IXtermTerminal & { raw: Terminal }): void {
		if (this._addon) {
			return;
		}
		this._addon = this.add(this._instantiationService.createInstance(TextAreaSyncAddon, this._instance.capabilities));
		xterm.raw.loadAddon(this._addon);
		this._addon.activate(xterm.raw);
	}
}
registerTerminalContribution(TextAreaSyncContribution.ID, TextAreaSyncContribution);


export class TerminalAccessibleViewContribution extends Disposable implements ITerminalContribution {
	static readonly ID = 'terminal.accessibleBufferProvider';
	static get(instance: ITerminalInstance): TerminalAccessibleViewContribution | null {
		return instance.getContribution<TerminalAccessibleViewContribution>(TerminalAccessibleViewContribution.ID);
	}
	private _bufferTracker: BufferContentTracker | undefined;
	private _bufferProvider: TerminalAccessibleBufferProvider | undefined;
	private _xterm: Pick<IXtermTerminal, 'shellIntegration' | 'getFont'> & { raw: Terminal } | undefined;
	private _onCommandExecutedShowListener: MutableDisposable<IDisposable> = new MutableDisposable();

	constructor(
		private readonly _instance: ITerminalInstance,
		processManager: ITerminalProcessManager,
		widgetManager: TerminalWidgetManager,
		@IAccessibleViewService private readonly _accessibleViewService: IAccessibleViewService,
		@IInstantiationService private readonly _instantiationService: IInstantiationService,
		@ITerminalService private readonly _terminalService: ITerminalService,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
		@IContextKeyService private readonly _contextKeyService: IContextKeyService) {
		super();
		this._register(AccessibleViewAction.addImplementation(90, 'terminal', () => {
			if (this._terminalService.activeInstance !== this._instance) {
				return false;
			}
			this.show();
			return true;
		}, TerminalContextKeys.focus));
		this._register(_instance.onDidRunText(() => {
			const focusAfterRun = _configurationService.getValue(TerminalSettingId.FocusAfterRun);
			if (focusAfterRun === 'terminal') {
				_instance.focus(true);
			} else if (focusAfterRun === 'accessible-buffer') {
				this.show();
			}
		}));
		this._register(this._configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(TerminalSettingId.AccessibleViewFocusOnCommandExecution)) {
				this._updateCommandExecutedListener();
			}
		}));
		this._register(this._instance.capabilities.onDidAddCapability(e => {
			if (e.capability.type === TerminalCapability.CommandDetection) {
				this._updateCommandExecutedListener();
			}
		}));
	}

	xtermReady(xterm: IXtermTerminal & { raw: Terminal }): void {
		const addon = this._instantiationService.createInstance(TextAreaSyncAddon, this._instance.capabilities);
		xterm.raw.loadAddon(addon);
		addon.activate(xterm.raw);
		this._xterm = xterm;
		this._register(this._xterm.raw.onWriteParsed(async () => {
			if (this._isTerminalAccessibleViewOpen() && this._xterm!.raw.buffer.active.baseY === 0) {
				this.show();
			}
		}));

		const onRequestUpdateEditor = Event.latch(this._xterm.raw.onScroll);
		this._register(onRequestUpdateEditor(() => {
			if (this._isTerminalAccessibleViewOpen()) {
				this.show();
			}
		}));
	}

	private _updateCommandExecutedListener(): void {
		if (!this._instance.capabilities.has(TerminalCapability.CommandDetection)) {
			return;
		}
		if (!this._configurationService.getValue(TerminalSettingId.AccessibleViewFocusOnCommandExecution)) {
			this._onCommandExecutedShowListener.clear();
			return;
		} else if (this._onCommandExecutedShowListener.value) {
			return;
		}

		const capability = this._instance.capabilities.get(TerminalCapability.CommandDetection)!;
		this._onCommandExecutedShowListener.value = this._register(capability.onCommandExecuted(() => this.show()));
	}

	private _isTerminalAccessibleViewOpen(): boolean {
		return accessibleViewCurrentProviderId.getValue(this._contextKeyService) === AccessibleViewProviderId.Terminal;
	}

	show(): void {
		if (!this._xterm) {
			return;
		}
		if (!this._bufferTracker) {
			this._bufferTracker = this._register(this._instantiationService.createInstance(BufferContentTracker, this._xterm));
		}
		if (!this._bufferProvider) {
			this._bufferProvider = this._register(this._instantiationService.createInstance(TerminalAccessibleBufferProvider, this._instance, this._bufferTracker, () => {
				return this._register(this._instantiationService.createInstance(TerminalAccessibilityHelpProvider, this._instance, this._xterm!)).provideContent();
			}));
		}
		const position = this._configurationService.getValue(TerminalSettingId.AccessibleViewPreserveCursorPosition) ? this._accessibleViewService.getPosition(AccessibleViewProviderId.Terminal) : undefined;
		this._accessibleViewService.show(this._bufferProvider, position);
	}
	navigateToCommand(type: NavigationType): void {
		const currentLine = this._accessibleViewService.getPosition(AccessibleViewProviderId.Terminal)?.lineNumber;
		const commands = this._getCommandsWithEditorLine();
		if (!commands?.length || !currentLine) {
			return;
		}

		const filteredCommands = type === NavigationType.Previous ? commands.filter(c => c.lineNumber < currentLine).sort((a, b) => b.lineNumber - a.lineNumber) : commands.filter(c => c.lineNumber > currentLine).sort((a, b) => a.lineNumber - b.lineNumber);
		if (!filteredCommands.length) {
			return;
		}
		this._accessibleViewService.setPosition(new Position(filteredCommands[0].lineNumber, 1), true);
	}

	private _getCommandsWithEditorLine(): ICommandWithEditorLine[] | undefined {
		const capability = this._instance.capabilities.get(TerminalCapability.CommandDetection);
		const commands = capability?.commands;
		const currentCommand = capability?.currentCommand;
		if (!commands?.length) {
			return;
		}
		const result: ICommandWithEditorLine[] = [];
		for (const command of commands) {
			const lineNumber = this._getEditorLineForCommand(command);
			if (!lineNumber) {
				continue;
			}
			result.push({ command, lineNumber });
		}
		if (currentCommand) {
			const lineNumber = this._getEditorLineForCommand(currentCommand);
			if (!!lineNumber) {
				result.push({ command: currentCommand, lineNumber });
			}
		}
		return result;
	}

	private _getEditorLineForCommand(command: ITerminalCommand | ICurrentPartialCommand): number | undefined {
		if (!this._bufferTracker) {
			return;
		}
		let line: number | undefined;
		if ('marker' in command) {
			line = command.marker?.line;
		} else if ('commandStartMarker' in command) {
			line = command.commandStartMarker?.line;
		}
		if (line === undefined || line < 0) {
			return;
		}
		line = this._bufferTracker.bufferToEditorLineMapping.get(line);
		if (line === undefined) {
			return;
		}
		return line + 1;
	}

}
registerTerminalContribution(TerminalAccessibleViewContribution.ID, TerminalAccessibleViewContribution);

export class TerminalAccessibilityHelpContribution extends Disposable {
	static ID: 'terminalAccessibilityHelpContribution';
	constructor() {
		super();

		this._register(AccessibilityHelpAction.addImplementation(105, 'terminal', async accessor => {
			const instantiationService = accessor.get(IInstantiationService);
			const terminalService = accessor.get(ITerminalService);
			const accessibleViewService = accessor.get(IAccessibleViewService);
			const instance = await terminalService.getActiveOrCreateInstance();
			await terminalService.revealActiveTerminal();
			const terminal = instance?.xterm;
			if (!terminal) {
				return;
			}
			accessibleViewService.show(instantiationService.createInstance(TerminalAccessibilityHelpProvider, instance, terminal));
		}, ContextKeyExpr.or(TerminalContextKeys.focus, ContextKeyExpr.and(accessibleViewIsShown, ContextKeyExpr.equals(accessibleViewCurrentProviderId.key, AccessibleViewProviderId.Terminal)))));
	}
}
registerTerminalContribution(TerminalAccessibilityHelpContribution.ID, TerminalAccessibilityHelpContribution);


class FocusAccessibleBufferAction extends Action2 {
	constructor() {
		super({
			id: TerminalCommandId.FocusAccessibleBuffer,
			title: { value: localize('workbench.action.terminal.focusAccessibleBuffer', 'Focus Accessible Terminal View'), original: 'Focus Accessible Terminal View' },
			precondition: ContextKeyExpr.or(TerminalContextKeys.processSupported, TerminalContextKeys.terminalHasBeenCreated),
			keybinding: [
				{
					primary: KeyMod.Alt | KeyCode.F2,
					secondary: [KeyMod.CtrlCmd | KeyCode.UpArrow],
					linux: {
						primary: KeyMod.Alt | KeyCode.F2 | KeyMod.Shift,
						secondary: [KeyMod.CtrlCmd | KeyCode.UpArrow]
					},
					weight: KeybindingWeight.WorkbenchContrib,
					when: ContextKeyExpr.and(CONTEXT_ACCESSIBILITY_MODE_ENABLED, TerminalContextKeys.focus)
				}
			]
		});
	}
	override async run(accessor: ServicesAccessor, ...args: any[]): Promise<void> {
		const terminalService = accessor.get(ITerminalService);
		const terminal = await terminalService.getActiveOrCreateInstance();
		if (!terminal?.xterm) {
			return;
		}
		TerminalAccessibleViewContribution.get(terminal)?.show();
	}
}
registerAction2(FocusAccessibleBufferAction);

registerTerminalAction({
	id: TerminalCommandId.AccessibleBufferGoToNextCommand,
	title: { value: localize('workbench.action.terminal.accessibleBufferGoToNextCommand', 'Accessible Buffer Go to Next Command'), original: 'Accessible Buffer Go to Next Command' },
	precondition: ContextKeyExpr.or(TerminalContextKeys.processSupported, TerminalContextKeys.terminalHasBeenCreated, ContextKeyExpr.and(accessibleViewIsShown, ContextKeyExpr.equals(accessibleViewCurrentProviderId.key, AccessibleViewProviderId.Terminal))),
	keybinding: [
		{
			primary: KeyMod.Alt | KeyCode.DownArrow,
			when: ContextKeyExpr.and(ContextKeyExpr.and(accessibleViewIsShown, ContextKeyExpr.equals(accessibleViewCurrentProviderId.key, AccessibleViewProviderId.Terminal))),
			weight: KeybindingWeight.WorkbenchContrib + 2
		}
	],
	run: async (c) => {
		const instance = await c.service.activeInstance;
		if (!instance) {
			return;
		}
		await TerminalAccessibleViewContribution.get(instance)?.navigateToCommand(NavigationType.Next);
	}
});


registerTerminalAction({
	id: TerminalCommandId.AccessibleBufferGoToPreviousCommand,
	title: { value: localize('workbench.action.terminal.accessibleBufferGoToPreviousCommand', 'Accessible Buffer Go to Previous Command'), original: 'Accessible Buffer Go to Previous Command' },
	precondition: ContextKeyExpr.and(ContextKeyExpr.or(TerminalContextKeys.processSupported, TerminalContextKeys.terminalHasBeenCreated), ContextKeyExpr.and(accessibleViewIsShown, ContextKeyExpr.equals(accessibleViewCurrentProviderId.key, AccessibleViewProviderId.Terminal))),
	keybinding: [
		{
			primary: KeyMod.Alt | KeyCode.UpArrow,
			when: ContextKeyExpr.and(ContextKeyExpr.and(accessibleViewIsShown, ContextKeyExpr.equals(accessibleViewCurrentProviderId.key, AccessibleViewProviderId.Terminal))),
			weight: KeybindingWeight.WorkbenchContrib + 2
		}
	],
	run: async (c) => {
		const instance = await c.service.activeInstance;
		if (!instance) {
			return;
		}
		await TerminalAccessibleViewContribution.get(instance)?.navigateToCommand(NavigationType.Previous);
	}
});
