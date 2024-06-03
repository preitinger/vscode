/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as dom from 'vs/base/browser/dom';
import { KeyCode } from 'vs/base/common/keyCodes';
import { Disposable, DisposableStore, IDisposable, toDisposable } from 'vs/base/common/lifecycle';
import { ICodeEditor, IEditorMouseEvent, MouseTargetType } from 'vs/editor/browser/editorBrowser';
import { EditorOption } from 'vs/editor/common/config/editorOptions';
import { Position } from 'vs/editor/common/core/position';
import { Range } from 'vs/editor/common/core/range';
import { ModelDecorationOptions } from 'vs/editor/common/model/textModel';
import { TokenizationRegistry } from 'vs/editor/common/languages';
import { HoverOperation, HoverStartMode, HoverStartSource } from 'vs/editor/contrib/hover/browser/hoverOperation';
import { HoverAnchor, HoverParticipantRegistry, HoverRangeAnchor, IEditorHoverColorPickerWidget, IEditorHoverParticipant, IEditorHoverRenderContext, IHoverPart, IHoverWidget } from 'vs/editor/contrib/hover/browser/hoverTypes';
import { IInstantiationService } from 'vs/platform/instantiation/common/instantiation';
import { IKeybindingService } from 'vs/platform/keybinding/common/keybinding';
import { MarkdownHoverParticipant } from 'vs/editor/contrib/hover/browser/markdownHoverParticipant';
import { InlayHintsHover } from 'vs/editor/contrib/inlayHints/browser/inlayHintsHover';
import { HoverVerbosityAction } from 'vs/editor/common/standalone/standaloneEnums';
import { ContentHoverWidget } from 'vs/editor/contrib/hover/browser/contentHoverWidget';
import { ContentHoverComputer } from 'vs/editor/contrib/hover/browser/contentHoverComputer';
import { ContentHoverVisibleData, HoverResult } from 'vs/editor/contrib/hover/browser/contentHoverTypes';
import { EditorHoverStatusBar } from 'vs/editor/contrib/hover/browser/contentHoverStatusBar';
import { Emitter } from 'vs/base/common/event';

interface RenderedHoverPart {
	brand: `renderedHoverPart`;
	element: HTMLElement;
	hoverPart: IHoverPart;
	participant: IEditorHoverParticipant<IHoverPart>;
}

interface RenderedHoverStatusBar {
	brand: `renderedStatusBar`;
	element: HTMLElement;
}

type RenderedPart = RenderedHoverPart | RenderedHoverStatusBar;

export class ContentHoverController extends Disposable implements IHoverWidget {

	private _currentResult: HoverResult | null = null;
	private _renderedParts: RenderedPart[] = [];
	private _colorWidget: IEditorHoverColorPickerWidget | null = null;
	private _focusedHoverPartIndex: number = -1;

	private readonly _computer: ContentHoverComputer;
	private readonly _widget: ContentHoverWidget;
	private readonly _participants: IEditorHoverParticipant[];
	// TODO@aiday-mar make array of participants, dispatch between them
	private readonly _markdownHoverParticipant: MarkdownHoverParticipant | undefined;
	private readonly _hoverOperation: HoverOperation<IHoverPart>;

	private readonly _onContentsChanged = this._register(new Emitter<void>());
	public readonly onContentsChanged = this._onContentsChanged.event;

	constructor(
		private readonly _editor: ICodeEditor,
		@IInstantiationService private readonly _instantiationService: IInstantiationService,
		@IKeybindingService private readonly _keybindingService: IKeybindingService,
	) {
		super();

		this._widget = this._register(this._instantiationService.createInstance(ContentHoverWidget, this._editor));

		// Instantiate participants and sort them by `hoverOrdinal` which is relevant for rendering order.
		this._participants = [];
		for (const participant of HoverParticipantRegistry.getAll()) {
			const participantInstance = this._instantiationService.createInstance(participant, this._editor);
			if (participantInstance instanceof MarkdownHoverParticipant && !(participantInstance instanceof InlayHintsHover)) {
				this._markdownHoverParticipant = participantInstance;
			}
			this._participants.push(participantInstance);
		}
		this._participants.sort((p1, p2) => p1.hoverOrdinal - p2.hoverOrdinal);

		this._computer = new ContentHoverComputer(this._editor, this._participants);
		this._hoverOperation = this._register(new HoverOperation(this._editor, this._computer));

		this._register(this._hoverOperation.onResult((result) => {
			if (!this._computer.anchor) {
				// invalid state, ignore result
				return;
			}
			const messages = (result.hasLoadingMessage ? this._addLoadingMessage(result.value) : result.value);
			this._withResult(new HoverResult(this._computer.anchor, messages, result.isComplete));
		}));
		this._register(dom.addStandardDisposableListener(this._widget.getDomNode(), 'keydown', (e) => {
			if (e.equals(KeyCode.Escape)) {
				this.hide();
			}
		}));
		this._register(TokenizationRegistry.onDidChange(() => {
			if (this._widget.position && this._currentResult) {
				this._setCurrentResult(this._currentResult); // render again
			}
		}));
	}

	/**
	 * Returns true if the hover shows now or will show.
	 */
	private _startShowingOrUpdateHover(
		anchor: HoverAnchor | null,
		mode: HoverStartMode,
		source: HoverStartSource,
		focus: boolean,
		mouseEvent: IEditorMouseEvent | null
	): boolean {

		if (!this._widget.position || !this._currentResult) {
			// The hover is not visible
			if (anchor) {
				this._startHoverOperationIfNecessary(anchor, mode, source, focus, false);
				return true;
			}
			return false;
		}

		// The hover is currently visible
		const isHoverSticky = this._editor.getOption(EditorOption.hover).sticky;
		const isGettingCloser = (
			isHoverSticky
			&& mouseEvent
			&& this._widget.isMouseGettingCloser(mouseEvent.event.posx, mouseEvent.event.posy)
		);

		if (isGettingCloser) {
			// The mouse is getting closer to the hover, so we will keep the hover untouched
			// But we will kick off a hover update at the new anchor, insisting on keeping the hover visible.
			if (anchor) {
				this._startHoverOperationIfNecessary(anchor, mode, source, focus, true);
			}
			return true;
		}

		if (!anchor) {
			this._setCurrentResult(null);
			return false;
		}

		if (anchor && this._currentResult.anchor.equals(anchor)) {
			// The widget is currently showing results for the exact same anchor, so no update is needed
			return true;
		}

		if (!anchor.canAdoptVisibleHover(this._currentResult.anchor, this._widget.position)) {
			// The new anchor is not compatible with the previous anchor
			this._setCurrentResult(null);
			this._startHoverOperationIfNecessary(anchor, mode, source, focus, false);
			return true;
		}

		// We aren't getting any closer to the hover, so we will filter existing results
		// and keep those which also apply to the new anchor.
		this._setCurrentResult(this._currentResult.filter(anchor));
		this._startHoverOperationIfNecessary(anchor, mode, source, focus, false);
		return true;
	}

	private _startHoverOperationIfNecessary(anchor: HoverAnchor, mode: HoverStartMode, source: HoverStartSource, focus: boolean, insistOnKeepingHoverVisible: boolean): void {

		if (this._computer.anchor && this._computer.anchor.equals(anchor)) {
			// We have to start a hover operation at the exact same anchor as before, so no work is needed
			return;
		}
		this._hoverOperation.cancel();
		this._computer.anchor = anchor;
		this._computer.shouldFocus = focus;
		this._computer.source = source;
		this._computer.insistOnKeepingHoverVisible = insistOnKeepingHoverVisible;
		this._hoverOperation.start(mode);
	}

	private _setCurrentResult(hoverResult: HoverResult | null): void {

		if (this._currentResult === hoverResult) {
			// avoid updating the DOM to avoid resetting the user selection
			return;
		}
		if (hoverResult && hoverResult.messages.length === 0) {
			hoverResult = null;
		}
		this._currentResult = hoverResult;
		if (this._currentResult) {
			this._renderHoverParts(this._currentResult.anchor, this._currentResult.messages);
		} else {
			this._widget.hide();
		}
	}

	private _addLoadingMessage(result: IHoverPart[]): IHoverPart[] {
		if (this._computer.anchor) {
			for (const participant of this._participants) {
				if (participant.createLoadingMessage) {
					const loadingMessage = participant.createLoadingMessage(this._computer.anchor);
					if (loadingMessage) {
						return result.slice(0).concat([loadingMessage]);
					}
				}
			}
		}
		return result;
	}

	private _withResult(hoverResult: HoverResult): void {
		if (this._widget.position && this._currentResult && this._currentResult.isComplete) {
			// The hover is visible with a previous complete result.

			if (!hoverResult.isComplete) {
				// Instead of rendering the new partial result, we wait for the result to be complete.
				return;
			}

			if (this._computer.insistOnKeepingHoverVisible && hoverResult.messages.length === 0) {
				// The hover would now hide normally, so we'll keep the previous messages
				return;
			}
		}

		this._setCurrentResult(hoverResult);
	}

	private _renderHoverParts(anchor: HoverAnchor, hoverParts: IHoverPart[]): void {

		const disposables = new DisposableStore();
		const fragment = document.createDocumentFragment();
		disposables.add(this._renderHoverPartsInFragment(fragment, hoverParts));
		disposables.add(this._registerHoverListeners());

		if (fragment.hasChildNodes()) {
			const { showAtPosition, showAtSecondaryPosition, highlightRange } = ContentHoverController.computeHoverRanges(this._editor, anchor.range, hoverParts);
			if (highlightRange) {
				const highlightDecoration = this._editor.createDecorationsCollection();
				highlightDecoration.set([{
					range: highlightRange,
					options: ContentHoverController._DECORATION_OPTIONS
				}]);
				disposables.add(toDisposable(() => {
					highlightDecoration.clear();
				}));
			}

			const isBeforeContent = hoverParts.some(m => m.isBeforeContent);
			this._widget.showAt(fragment, new ContentHoverVisibleData(
				anchor.initialMousePosX,
				anchor.initialMousePosY,
				this._colorWidget,
				showAtPosition,
				showAtSecondaryPosition,
				this._editor.getOption(EditorOption.hover).above,
				this._computer.shouldFocus,
				this._computer.source,
				isBeforeContent,
				disposables
			));
		} else {
			disposables.dispose();
		}
	}

	private _renderHoverPartsInFragment(fragment: DocumentFragment, hoverParts: IHoverPart[]): IDisposable {
		const disposables = new DisposableStore();
		const hoverContextAndStatusBar = this._getHoverContextAndStatusBar(fragment);
		const statusBar = hoverContextAndStatusBar.statusBar;
		const hoverRenderContext = hoverContextAndStatusBar.context;
		const renderedHoverParts = this._renderHoverPartsWithContext(hoverRenderContext, hoverParts);
		const renderedStatusBar = this._renderStatusBar(fragment, statusBar);
		this._renderedParts = [];
		this._renderedParts.push(...renderedHoverParts.renderedHoverParts);
		if (renderedStatusBar) { this._renderedParts.push(renderedStatusBar); }
		disposables.add(renderedHoverParts.disposables);
		disposables.add(statusBar);
		return disposables;
	}

	private _getHoverContextAndStatusBar(fragment: DocumentFragment,): {
		context: IEditorHoverRenderContext;
		statusBar: EditorHoverStatusBar;
	} {
		const hide = () => this.hide();
		const onContentsChanged = () => this._doOnContentsChanged();
		const statusBar = new EditorHoverStatusBar(this._keybindingService);
		const setColorPicker = (widget: IEditorHoverColorPickerWidget) => { this._colorWidget = widget; };
		const setMinimumDimensions = (dimensions: dom.Dimension) => this._widget.setMinimumDimensions(dimensions);
		const context: IEditorHoverRenderContext = {
			hide,
			fragment,
			statusBar,
			setColorPicker,
			onContentsChanged,
			setMinimumDimensions,
		};
		return { context, statusBar };
	}

	private _renderHoverPartsWithContext(context: IEditorHoverRenderContext, hoverParts: IHoverPart[]): {
		disposables: DisposableStore;
		renderedHoverParts: RenderedHoverPart[];
	} {
		const disposables = new DisposableStore();
		const renderedHoverParts: RenderedHoverPart[] = [];
		for (const participant of this._participants) {
			const hoverPartsForParticipant = hoverParts.filter(msg => msg.owner === participant);
			if (hoverPartsForParticipant.length === 0) {
				continue;
			}
			const { disposables: store, elements } = participant.renderHoverParts(context, hoverPartsForParticipant);
			hoverPartsForParticipant.forEach((hoverPart: IHoverPart, index: number) => {
				const element = elements[index];
				renderedHoverParts.push({
					brand: `renderedHoverPart`,
					participant,
					hoverPart,
					element
				});
			});
			disposables.add(store);
		}
		return { disposables, renderedHoverParts };
	}

	private _renderStatusBar(fragment: DocumentFragment, statusBar: EditorHoverStatusBar): RenderedHoverStatusBar | undefined {
		if (!statusBar.hasContent) {
			return;
		}
		fragment.appendChild(statusBar.hoverElement);
		return {
			brand: `renderedStatusBar`,
			element: statusBar.hoverElement
		};
	}

	private _registerHoverListeners(): IDisposable {
		const disposables = new DisposableStore();
		this._renderedParts.map((renderedPart: RenderedPart, index: number) => {
			const element = renderedPart.element;
			element.tabIndex = 0;
			disposables.add(dom.addDisposableListener(element, dom.EventType.FOCUS_IN, (event: Event) => {
				event.stopPropagation();
				this._focusedHoverPartIndex = index;
			}));
			disposables.add(dom.addDisposableListener(element, dom.EventType.FOCUS_OUT, (event: Event) => {
				event.stopPropagation();
				this._focusedHoverPartIndex = -1;
			}));
		});
		return disposables;
	}

	private _doOnContentsChanged(): void {
		this._onContentsChanged.fire();
		this._widget.onContentsChanged();
	}

	private static readonly _DECORATION_OPTIONS = ModelDecorationOptions.register({
		description: 'content-hover-highlight',
		className: 'hoverHighlight'
	});

	public static computeHoverRanges(editor: ICodeEditor, anchorRange: Range, messages: IHoverPart[]) {

		let startColumnBoundary = 1;
		if (editor.hasModel()) {
			// Ensure the range is on the current view line
			const viewModel = editor._getViewModel();
			const coordinatesConverter = viewModel.coordinatesConverter;
			const anchorViewRange = coordinatesConverter.convertModelRangeToViewRange(anchorRange);
			const anchorViewRangeStart = new Position(anchorViewRange.startLineNumber, viewModel.getLineMinColumn(anchorViewRange.startLineNumber));
			startColumnBoundary = coordinatesConverter.convertViewPositionToModelPosition(anchorViewRangeStart).column;
		}

		// The anchor range is always on a single line
		const anchorLineNumber = anchorRange.startLineNumber;
		let renderStartColumn = anchorRange.startColumn;
		let highlightRange = messages[0].range;
		let forceShowAtRange = null;

		for (const msg of messages) {
			highlightRange = Range.plusRange(highlightRange, msg.range);
			if (msg.range.startLineNumber === anchorLineNumber && msg.range.endLineNumber === anchorLineNumber) {
				// this message has a range that is completely sitting on the line of the anchor
				renderStartColumn = Math.max(Math.min(renderStartColumn, msg.range.startColumn), startColumnBoundary);
			}
			if (msg.forceShowAtRange) {
				forceShowAtRange = msg.range;
			}
		}

		const showAtPosition = forceShowAtRange ? forceShowAtRange.getStartPosition() : new Position(anchorLineNumber, anchorRange.startColumn);
		const showAtSecondaryPosition = forceShowAtRange ? forceShowAtRange.getStartPosition() : new Position(anchorLineNumber, renderStartColumn);

		return {
			showAtPosition,
			showAtSecondaryPosition,
			highlightRange
		};
	}

	public showsOrWillShow(mouseEvent: IEditorMouseEvent): boolean {

		if (this._widget.isResizing) {
			return true;
		}

		const anchorCandidates: HoverAnchor[] = [];
		for (const participant of this._participants) {
			if (participant.suggestHoverAnchor) {
				const anchor = participant.suggestHoverAnchor(mouseEvent);
				if (anchor) {
					anchorCandidates.push(anchor);
				}
			}
		}

		const target = mouseEvent.target;

		if (target.type === MouseTargetType.CONTENT_TEXT) {
			anchorCandidates.push(new HoverRangeAnchor(0, target.range, mouseEvent.event.posx, mouseEvent.event.posy));
		}

		if (target.type === MouseTargetType.CONTENT_EMPTY) {
			const epsilon = this._editor.getOption(EditorOption.fontInfo).typicalHalfwidthCharacterWidth / 2;
			if (
				!target.detail.isAfterLines
				&& typeof target.detail.horizontalDistanceToText === 'number'
				&& target.detail.horizontalDistanceToText < epsilon
			) {
				// Let hover kick in even when the mouse is technically in the empty area after a line, given the distance is small enough
				anchorCandidates.push(new HoverRangeAnchor(0, target.range, mouseEvent.event.posx, mouseEvent.event.posy));
			}
		}

		if (anchorCandidates.length === 0) {
			return this._startShowingOrUpdateHover(null, HoverStartMode.Delayed, HoverStartSource.Mouse, false, mouseEvent);
		}

		anchorCandidates.sort((a, b) => b.priority - a.priority);
		return this._startShowingOrUpdateHover(anchorCandidates[0], HoverStartMode.Delayed, HoverStartSource.Mouse, false, mouseEvent);
	}

	public startShowingAtRange(range: Range, mode: HoverStartMode, source: HoverStartSource, focus: boolean): void {
		this._startShowingOrUpdateHover(new HoverRangeAnchor(0, range, undefined, undefined), mode, source, focus, null);
	}

	public async updateMarkdownHoverVerbosityLevel(action: HoverVerbosityAction, index?: number, focus?: boolean): Promise<void> {
		this._markdownHoverParticipant?.updateMarkdownHoverVerbosityLevel(action, index, focus);
	}

	public focusedMarkdownHoverIndex(): number {
		return this._markdownHoverParticipant?.focusedMarkdownHoverIndex() ?? -1;
	}

	public focusedHoverPartIndex(): number {
		return this._focusedHoverPartIndex;
	}

	public doesMarkdownHoverAtIndexSupportVerbosityAction(index: number, action: HoverVerbosityAction): boolean {
		return this._markdownHoverParticipant?.doesMarkdownHoverAtIndexSupportVerbosityAction(index, action) ?? false;
	}

	public getWidgetContent(): string | undefined {
		const node = this._widget.getDomNode();
		if (!node.textContent) {
			return undefined;
		}
		return node.textContent;
	}

	public getAccessibleWidgetContent(): string | undefined {
		const formattedContent: string[] = [];
		for (let i = 0; i < this._renderedParts.length; i++) {
			formattedContent.push(this.getAccessibleWidgetContentAtIndex(i));
		}
		return formattedContent.join('\n\n');
	}

	public getAccessibleWidgetContentAtIndex(index: number): string {
		const renderedHoverPart = this._renderedParts[index];
		if (renderedHoverPart.brand === `renderedStatusBar`) {
			return `There is a status bar here`;
		}
		if (renderedHoverPart.brand === `renderedHoverPart`) {
			const { participant, hoverPart } = renderedHoverPart;
			return participant.getAccessibleContent(hoverPart);
		}
		return '';
	}

	public containsNode(node: Node | null | undefined): boolean {
		return (node ? this._widget.getDomNode().contains(node) : false);
	}

	public focus(): void {
		this._widget.focus();
	}

	public scrollUp(): void {
		this._widget.scrollUp();
	}

	public scrollDown(): void {
		this._widget.scrollDown();
	}

	public scrollLeft(): void {
		this._widget.scrollLeft();
	}

	public scrollRight(): void {
		this._widget.scrollRight();
	}

	public pageUp(): void {
		this._widget.pageUp();
	}

	public pageDown(): void {
		this._widget.pageDown();
	}

	public goToTop(): void {
		this._widget.goToTop();
	}

	public goToBottom(): void {
		this._widget.goToBottom();
	}

	public hide(): void {
		this._computer.anchor = null;
		this._hoverOperation.cancel();
		this._setCurrentResult(null);
	}

	public get isColorPickerVisible(): boolean {
		return this._widget.isColorPickerVisible;
	}

	public get isVisibleFromKeyboard(): boolean {
		return this._widget.isVisibleFromKeyboard;
	}

	public get isVisible(): boolean {
		return this._widget.isVisible;
	}

	public get isFocused(): boolean {
		return this._widget.isFocused;
	}

	public get isResizing(): boolean {
		return this._widget.isResizing;
	}

	public get widget() {
		return this._widget;
	}
}
