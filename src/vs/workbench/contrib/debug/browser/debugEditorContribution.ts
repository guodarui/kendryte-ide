/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as nls from 'vs/nls';
import { RunOnceScheduler } from 'vs/base/common/async';
import * as env from 'vs/base/common/platform';
import { visit } from 'vs/base/common/json';
import { Constants } from 'vs/base/common/uint';
import { KeyCode } from 'vs/base/common/keyCodes';
import { IKeyboardEvent } from 'vs/base/browser/keyboardEvent';
import { StandardTokenType } from 'vs/editor/common/modes';
import { DEFAULT_WORD_REGEXP } from 'vs/editor/common/model/wordHelper';
import { ICodeEditor, IEditorMouseEvent, MouseTargetType } from 'vs/editor/browser/editorBrowser';
import { registerEditorContribution } from 'vs/editor/browser/editorExtensions';
import { IDecorationOptions } from 'vs/editor/common/editorCommon';
import { ICodeEditorService } from 'vs/editor/browser/services/codeEditorService';
import { Range } from 'vs/editor/common/core/range';
import { IInstantiationService } from 'vs/platform/instantiation/common/instantiation';
import { ITelemetryService } from 'vs/platform/telemetry/common/telemetry';
import { IConfigurationService } from 'vs/platform/configuration/common/configuration';
import { ICommandService } from 'vs/platform/commands/common/commands';
import { IDebugEditorContribution, IDebugService, State, EDITOR_CONTRIBUTION_ID, IStackFrame, IDebugConfiguration, IExpression, IExceptionInfo, IDebugSession } from 'vs/workbench/contrib/debug/common/debug';
import { ExceptionWidget } from 'vs/workbench/contrib/debug/browser/exceptionWidget';
import { FloatingClickWidget } from 'vs/workbench/browser/parts/editor/editorWidgets';
import { Position } from 'vs/editor/common/core/position';
import { CoreEditingCommands } from 'vs/editor/browser/controller/coreCommands';
import { first } from 'vs/base/common/arrays';
import { memoize } from 'vs/base/common/decorators';
import { IEditorHoverOptions, EditorOption } from 'vs/editor/common/config/editorOptions';
import { CancellationToken } from 'vs/base/common/cancellation';
import { DebugHoverWidget } from 'vs/workbench/contrib/debug/browser/debugHover';
import { ITextModel } from 'vs/editor/common/model';
import { getHover } from 'vs/editor/contrib/hover/getHover';
import { dispose, IDisposable } from 'vs/base/common/lifecycle';

const HOVER_DELAY = 300;
const LAUNCH_JSON_REGEX = /launch\.json$/;
const INLINE_VALUE_DECORATION_KEY = 'inlinevaluedecoration';
const MAX_NUM_INLINE_VALUES = 100; // JS Global scope can have 700+ entries. We want to limit ourselves for perf reasons
const MAX_INLINE_DECORATOR_LENGTH = 150; // Max string length of each inline decorator when debugging. If exceeded ... is added
const MAX_TOKENIZATION_LINE_LEN = 500; // If line is too long, then inline values for the line are skipped

class DebugEditorContribution implements IDebugEditorContribution {

	private toDispose: IDisposable[];
	private hoverWidget: DebugHoverWidget;
	private nonDebugHoverPosition: Position | undefined;
	private hoverRange: Range | null = null;
	private mouseDown = false;

	private wordToLineNumbersMap: Map<string, Position[]> | undefined;

	private exceptionWidget: ExceptionWidget | undefined;

	private configurationWidget: FloatingClickWidget | undefined;

	constructor(
		private editor: ICodeEditor,
		@IDebugService private readonly debugService: IDebugService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@ICommandService private readonly commandService: ICommandService,
		@ICodeEditorService private readonly codeEditorService: ICodeEditorService,
		@ITelemetryService private readonly telemetryService: ITelemetryService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
	) {
		this.hoverWidget = this.instantiationService.createInstance(DebugHoverWidget, this.editor);
		this.toDispose = [];
		this.registerListeners();
		this.updateConfigurationWidgetVisibility();
		this.codeEditorService.registerDecorationType(INLINE_VALUE_DECORATION_KEY, {});
		this.toggleExceptionWidget();
	}

	private registerListeners(): void {
		this.toDispose.push(this.debugService.getViewModel().onDidFocusStackFrame(e => this.onFocusStackFrame(e.stackFrame)));

		// hover listeners & hover widget
		this.toDispose.push(this.editor.onMouseDown((e: IEditorMouseEvent) => this.onEditorMouseDown(e)));
		this.toDispose.push(this.editor.onMouseUp(() => this.mouseDown = false));
		this.toDispose.push(this.editor.onMouseMove((e: IEditorMouseEvent) => this.onEditorMouseMove(e)));
		this.toDispose.push(this.editor.onMouseLeave((e: IEditorMouseEvent) => {
			this.provideNonDebugHoverScheduler.cancel();
			const hoverDomNode = this.hoverWidget.getDomNode();
			if (!hoverDomNode) {
				return;
			}

			const rect = hoverDomNode.getBoundingClientRect();
			// Only hide the hover widget if the editor mouse leave event is outside the hover widget #3528
			if (e.event.posx < rect.left || e.event.posx > rect.right || e.event.posy < rect.top || e.event.posy > rect.bottom) {
				this.hideHoverWidget();
			}
		}));
		this.toDispose.push(this.editor.onKeyDown((e: IKeyboardEvent) => this.onKeyDown(e)));
		this.toDispose.push(this.editor.onDidChangeModelContent(() => {
			this.wordToLineNumbersMap = undefined;
			this.updateInlineValuesScheduler.schedule();
		}));
		this.toDispose.push(this.editor.onDidChangeModel(async () => {
			const stackFrame = this.debugService.getViewModel().focusedStackFrame;
			const model = this.editor.getModel();
			if (model) {
				this._applyHoverConfiguration(model, stackFrame);
			}
			this.toggleExceptionWidget();
			this.hideHoverWidget();
			this.updateConfigurationWidgetVisibility();
			this.wordToLineNumbersMap = undefined;
			await this.updateInlineValueDecorations(stackFrame);
		}));
		this.toDispose.push(this.editor.onDidScrollChange(() => this.hideHoverWidget));
		this.toDispose.push(this.debugService.onDidChangeState((state: State) => {
			if (state !== State.Stopped) {
				this.toggleExceptionWidget();
			}
		}));
	}

	private _applyHoverConfiguration(model: ITextModel, stackFrame: IStackFrame | undefined): void {
		if (stackFrame && model.uri.toString() === stackFrame.source.uri.toString()) {
			this.editor.updateOptions({
				hover: {
					enabled: false
				}
			});
		} else {
			let overrides = {
				resource: model.uri,
				overrideIdentifier: model.getLanguageIdentifier().language
			};
			const defaultConfiguration = this.configurationService.getValue<IEditorHoverOptions>('editor.hover', overrides);
			this.editor.updateOptions({
				hover: {
					enabled: defaultConfiguration.enabled,
					delay: defaultConfiguration.delay,
					sticky: defaultConfiguration.sticky
				}
			});
		}
	}

	getId(): string {
		return EDITOR_CONTRIBUTION_ID;
	}

	async showHover(range: Range, focus: boolean): Promise<void> {
		const sf = this.debugService.getViewModel().focusedStackFrame;
		const model = this.editor.getModel();
		if (sf && model && sf.source.uri.toString() === model.uri.toString()) {
			return this.hoverWidget.showAt(range, focus);
		}
	}

	private async onFocusStackFrame(sf: IStackFrame | undefined): Promise<void> {
		const model = this.editor.getModel();
		if (model) {
			this._applyHoverConfiguration(model, sf);
			if (sf && sf.source.uri.toString() === model.uri.toString()) {
				await this.toggleExceptionWidget();
			} else {
				this.hideHoverWidget();
			}
		}

		await this.updateInlineValueDecorations(sf);
	}

	@memoize
	private get showHoverScheduler(): RunOnceScheduler {
		const scheduler = new RunOnceScheduler(() => {
			if (this.hoverRange) {
				this.showHover(this.hoverRange, false);
			}
		}, HOVER_DELAY);
		this.toDispose.push(scheduler);

		return scheduler;
	}

	@memoize
	private get hideHoverScheduler(): RunOnceScheduler {
		const scheduler = new RunOnceScheduler(() => {
			if (!this.hoverWidget.isHovered()) {
				this.hoverWidget.hide();
			}
		}, 2 * HOVER_DELAY);
		this.toDispose.push(scheduler);

		return scheduler;
	}

	@memoize
	private get provideNonDebugHoverScheduler(): RunOnceScheduler {
		const scheduler = new RunOnceScheduler(() => {
			if (this.editor.hasModel() && this.nonDebugHoverPosition) {
				getHover(this.editor.getModel(), this.nonDebugHoverPosition, CancellationToken.None);
			}
		}, HOVER_DELAY);
		this.toDispose.push(scheduler);

		return scheduler;
	}

	private hideHoverWidget(): void {
		if (!this.hideHoverScheduler.isScheduled() && this.hoverWidget.isVisible()) {
			this.hideHoverScheduler.schedule();
		}
		this.showHoverScheduler.cancel();
		this.provideNonDebugHoverScheduler.cancel();
	}

	// hover business

	private onEditorMouseDown(mouseEvent: IEditorMouseEvent): void {
		this.mouseDown = true;
		if (mouseEvent.target.type === MouseTargetType.CONTENT_WIDGET && mouseEvent.target.detail === DebugHoverWidget.ID) {
			return;
		}

		this.hideHoverWidget();
	}

	private onEditorMouseMove(mouseEvent: IEditorMouseEvent): void {
		if (this.debugService.state !== State.Stopped) {
			return;
		}

		if (this.configurationService.getValue<IDebugConfiguration>('debug').enableAllHovers && mouseEvent.target.position) {
			this.nonDebugHoverPosition = mouseEvent.target.position;
			this.provideNonDebugHoverScheduler.schedule();
		}
		const targetType = mouseEvent.target.type;
		const stopKey = env.isMacintosh ? 'metaKey' : 'ctrlKey';

		if (targetType === MouseTargetType.CONTENT_WIDGET && mouseEvent.target.detail === DebugHoverWidget.ID && !(<any>mouseEvent.event)[stopKey]) {
			// mouse moved on top of debug hover widget
			return;
		}
		if (targetType === MouseTargetType.CONTENT_TEXT) {
			if (mouseEvent.target.range && !mouseEvent.target.range.equalsRange(this.hoverRange)) {
				this.hoverRange = mouseEvent.target.range;
				this.showHoverScheduler.schedule();
			}
		} else if (!this.mouseDown) {
			// Do not hide debug hover when the mouse is pressed because it usually leads to accidental closing #64620
			this.hideHoverWidget();
		}
	}

	private onKeyDown(e: IKeyboardEvent): void {
		const stopKey = env.isMacintosh ? KeyCode.Meta : KeyCode.Ctrl;
		if (e.keyCode !== stopKey) {
			// do not hide hover when Ctrl/Meta is pressed
			this.hideHoverWidget();
		}
	}
	// end hover business

	// exception widget
	private async toggleExceptionWidget(): Promise<void> {
		// Toggles exception widget based on the state of the current editor model and debug stack frame
		const model = this.editor.getModel();
		const focusedSf = this.debugService.getViewModel().focusedStackFrame;
		const callStack = focusedSf ? focusedSf.thread.getCallStack() : null;
		if (!model || !focusedSf || !callStack || callStack.length === 0) {
			this.closeExceptionWidget();
			return;
		}

		// First call stack frame that is available is the frame where exception has been thrown
		const exceptionSf = first(callStack, sf => !!(sf && sf.source && sf.source.available && sf.source.presentationHint !== 'deemphasize'), undefined);
		if (!exceptionSf || exceptionSf !== focusedSf) {
			this.closeExceptionWidget();
			return;
		}

		const sameUri = exceptionSf.source.uri.toString() === model.uri.toString();
		if (this.exceptionWidget && !sameUri) {
			this.closeExceptionWidget();
		} else if (sameUri) {
			const exceptionInfo = await focusedSf.thread.exceptionInfo;
			if (exceptionInfo && exceptionSf.range.startLineNumber && exceptionSf.range.startColumn) {
				this.showExceptionWidget(exceptionInfo, this.debugService.getViewModel().focusedSession, exceptionSf.range.startLineNumber, exceptionSf.range.startColumn);
			}
		}
	}

	private showExceptionWidget(exceptionInfo: IExceptionInfo, debugSession: IDebugSession | undefined, lineNumber: number, column: number): void {
		if (this.exceptionWidget) {
			this.exceptionWidget.dispose();
		}

		this.exceptionWidget = this.instantiationService.createInstance(ExceptionWidget, this.editor, exceptionInfo, debugSession);
		this.exceptionWidget.show({ lineNumber, column }, 0);
		this.editor.revealLine(lineNumber);
	}

	private closeExceptionWidget(): void {
		if (this.exceptionWidget) {
			this.exceptionWidget.dispose();
			this.exceptionWidget = undefined;
		}
	}

	// configuration widget
	private updateConfigurationWidgetVisibility(): void {
		const model = this.editor.getModel();
		if (this.configurationWidget) {
			this.configurationWidget.dispose();
		}
		if (model && LAUNCH_JSON_REGEX.test(model.uri.toString()) && !this.editor.getOption(EditorOption.readOnly)) {
			this.configurationWidget = this.instantiationService.createInstance(FloatingClickWidget, this.editor, nls.localize('addConfiguration', "Add Configuration..."), null);
			this.configurationWidget.render();
			this.toDispose.push(this.configurationWidget.onClick(() => this.addLaunchConfiguration()));
		}
	}

	async addLaunchConfiguration(): Promise<any> {
		/* __GDPR__
			"debug/addLaunchConfiguration" : {}
		*/
		this.telemetryService.publicLog('debug/addLaunchConfiguration');
		let configurationsArrayPosition: Position | undefined;
		const model = this.editor.getModel();
		if (!model) {
			return;
		}

		let depthInArray = 0;
		let lastProperty: string;

		visit(model.getValue(), {
			onObjectProperty: (property, offset, length) => {
				lastProperty = property;
			},
			onArrayBegin: (offset: number, length: number) => {
				if (lastProperty === 'configurations' && depthInArray === 0) {
					configurationsArrayPosition = model.getPositionAt(offset + 1);
				}
				depthInArray++;
			},
			onArrayEnd: () => {
				depthInArray--;
			}
		});

		this.editor.focus();
		if (!configurationsArrayPosition) {
			return;
		}

		const insertLine = (position: Position): Promise<any> => {
			// Check if there are more characters on a line after a "configurations": [, if yes enter a newline
			if (model.getLineLastNonWhitespaceColumn(position.lineNumber) > position.column) {
				this.editor.setPosition(position);
				CoreEditingCommands.LineBreakInsert.runEditorCommand(null, this.editor, null);
			}
			this.editor.setPosition(position);
			return this.commandService.executeCommand('editor.action.insertLineAfter');
		};

		await insertLine(configurationsArrayPosition);
		await this.commandService.executeCommand('editor.action.triggerSuggest');
	}

	// Inline Decorations

	@memoize
	private get removeInlineValuesScheduler(): RunOnceScheduler {
		return new RunOnceScheduler(
			() => this.editor.removeDecorations(INLINE_VALUE_DECORATION_KEY),
			100
		);
	}

	@memoize
	private get updateInlineValuesScheduler(): RunOnceScheduler {
		return new RunOnceScheduler(
			async () => await this.updateInlineValueDecorations(this.debugService.getViewModel().focusedStackFrame),
			200
		);
	}

	private async updateInlineValueDecorations(stackFrame: IStackFrame | undefined): Promise<void> {
		const model = this.editor.getModel();
		if (!this.configurationService.getValue<IDebugConfiguration>('debug').inlineValues ||
			!model || !stackFrame || model.uri.toString() !== stackFrame.source.uri.toString()) {
			if (!this.removeInlineValuesScheduler.isScheduled()) {
				this.removeInlineValuesScheduler.schedule();
			}
			return;
		}

		this.removeInlineValuesScheduler.cancel();

		const scopes = await stackFrame.getMostSpecificScopes(stackFrame.range);
		// Get all top level children in the scope chain
		const decorationsPerScope = await Promise.all(scopes.map(async scope => {
			const children = await scope.getChildren();
			let range = new Range(0, 0, stackFrame.range.startLineNumber, stackFrame.range.startColumn);
			if (scope.range) {
				range = range.setStartPosition(scope.range.startLineNumber, scope.range.startColumn);
			}

			return this.createInlineValueDecorationsInsideRange(children, range, model);
		}));

		const allDecorations = decorationsPerScope.reduce((previous, current) => previous.concat(current), []);
		this.editor.setDecorations(INLINE_VALUE_DECORATION_KEY, allDecorations);
	}

	private createInlineValueDecorationsInsideRange(expressions: ReadonlyArray<IExpression>, range: Range, model: ITextModel): IDecorationOptions[] {
		const nameValueMap = new Map<string, string>();
		for (let expr of expressions) {
			nameValueMap.set(expr.name, expr.value);
			// Limit the size of map. Too large can have a perf impact
			if (nameValueMap.size >= MAX_NUM_INLINE_VALUES) {
				break;
			}
		}

		const lineToNamesMap: Map<number, string[]> = new Map<number, string[]>();
		const wordToPositionsMap = this.getWordToPositionsMap();

		// Compute unique set of names on each line
		nameValueMap.forEach((value, name) => {
			const positions = wordToPositionsMap.get(name);
			if (positions) {
				for (let position of positions) {
					if (range.containsPosition(position)) {
						if (!lineToNamesMap.has(position.lineNumber)) {
							lineToNamesMap.set(position.lineNumber, []);
						}

						if (lineToNamesMap.get(position.lineNumber)!.indexOf(name) === -1) {
							lineToNamesMap.get(position.lineNumber)!.push(name);
						}
					}
				}
			}
		});

		const decorations: IDecorationOptions[] = [];
		// Compute decorators for each line
		lineToNamesMap.forEach((names, line) => {
			const contentText = names.sort((first, second) => {
				const content = model.getLineContent(line);
				return content.indexOf(first) - content.indexOf(second);
			}).map(name => `${name} = ${nameValueMap.get(name)}`).join(', ');
			decorations.push(this.createInlineValueDecoration(line, contentText));
		});

		return decorations;
	}

	private createInlineValueDecoration(lineNumber: number, contentText: string): IDecorationOptions {
		// If decoratorText is too long, trim and add ellipses. This could happen for minified files with everything on a single line
		if (contentText.length > MAX_INLINE_DECORATOR_LENGTH) {
			contentText = contentText.substr(0, MAX_INLINE_DECORATOR_LENGTH) + '...';
		}

		return {
			range: {
				startLineNumber: lineNumber,
				endLineNumber: lineNumber,
				startColumn: Constants.MAX_SAFE_SMALL_INTEGER,
				endColumn: Constants.MAX_SAFE_SMALL_INTEGER
			},
			renderOptions: {
				after: {
					contentText,
					backgroundColor: 'rgba(255, 200, 0, 0.2)',
					margin: '10px'
				},
				dark: {
					after: {
						color: 'rgba(255, 255, 255, 0.5)',
					}
				},
				light: {
					after: {
						color: 'rgba(0, 0, 0, 0.5)',
					}
				}
			}
		};
	}

	private getWordToPositionsMap(): Map<string, Position[]> {
		if (!this.wordToLineNumbersMap) {
			this.wordToLineNumbersMap = new Map<string, Position[]>();
			const model = this.editor.getModel();
			if (!model) {
				return this.wordToLineNumbersMap;
			}

			// For every word in every line, map its ranges for fast lookup
			for (let lineNumber = 1, len = model.getLineCount(); lineNumber <= len; ++lineNumber) {
				const lineContent = model.getLineContent(lineNumber);

				// If line is too long then skip the line
				if (lineContent.length > MAX_TOKENIZATION_LINE_LEN) {
					continue;
				}

				model.forceTokenization(lineNumber);
				const lineTokens = model.getLineTokens(lineNumber);
				for (let tokenIndex = 0, tokenCount = lineTokens.getCount(); tokenIndex < tokenCount; tokenIndex++) {
					const tokenStartOffset = lineTokens.getStartOffset(tokenIndex);
					const tokenEndOffset = lineTokens.getEndOffset(tokenIndex);
					const tokenType = lineTokens.getStandardTokenType(tokenIndex);
					const tokenStr = lineContent.substring(tokenStartOffset, tokenEndOffset);

					// Token is a word and not a comment
					if (tokenType === StandardTokenType.Other) {
						DEFAULT_WORD_REGEXP.lastIndex = 0; // We assume tokens will usually map 1:1 to words if they match
						const wordMatch = DEFAULT_WORD_REGEXP.exec(tokenStr);

						if (wordMatch) {
							const word = wordMatch[0];
							if (!this.wordToLineNumbersMap.has(word)) {
								this.wordToLineNumbersMap.set(word, []);
							}

							this.wordToLineNumbersMap.get(word)!.push(new Position(lineNumber, tokenStartOffset));
						}
					}
				}
			}
		}

		return this.wordToLineNumbersMap;
	}

	dispose(): void {
		if (this.hoverWidget) {
			this.hoverWidget.dispose();
		}
		if (this.configurationWidget) {
			this.configurationWidget.dispose();
		}
		this.toDispose = dispose(this.toDispose);
	}
}

registerEditorContribution(DebugEditorContribution);
