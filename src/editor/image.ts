// How an image looks and behaves in the editor: select it to get a corner handle to drag and a
// small bar of sizes. The width is saved on the image (pixels), so it's kept in the file and
// in Word.

import type { Node as PMNode } from "prosemirror-model";
import type { EditorView, NodeView } from "prosemirror-view";

const MIN_WIDTH = 40;
const SIZES: [string, number | null][] = [
  ["¼", 0.25],
  ["½", 0.5],
  ["¾", 0.75],
  ["Full · كامل", 1],
  ["Original · الأصلي", null],
];

export class ImageView implements NodeView {
  dom: HTMLElement;
  private img: HTMLImageElement;

  constructor(
    private node: PMNode,
    private view: EditorView,
    private getPos: () => number | undefined,
  ) {
    this.dom = document.createElement("span");
    this.dom.className = "image-frame";
    this.img = this.dom.appendChild(document.createElement("img"));
    this.render();

    const handle = this.dom.appendChild(document.createElement("span"));
    handle.className = "image-handle";
    handle.title = "Drag to resize · اسحب لتغيير الحجم";
    handle.addEventListener("pointerdown", (e) => this.drag(e));

    const bar = this.dom.appendChild(document.createElement("span"));
    bar.className = "image-bar";
    for (const [label, fraction] of SIZES) {
      const b = bar.appendChild(document.createElement("button"));
      b.textContent = label;
      b.addEventListener("mousedown", (e) => e.preventDefault());
      b.addEventListener("click", () => this.setWidth(fraction === null ? null : Math.round(this.pageWidth() * fraction)));
    }
  }

  private render() {
    this.img.src = this.node.attrs.src;
    this.img.alt = this.node.attrs.alt ?? "";
    this.img.style.width = this.node.attrs.width ? `${this.node.attrs.width}px` : "";
  }

  /** The text width of the page: an image is never wider. */
  private pageWidth() {
    const style = getComputedStyle(this.view.dom);
    return this.view.dom.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
  }

  private setWidth(width: number | null) {
    const pos = this.getPos();
    if (pos === undefined) return;
    this.view.dispatch(this.view.state.tr.setNodeMarkup(pos, undefined, { ...this.node.attrs, width }));
    this.view.focus();
  }

  /** Dragging the corner: towards the outside makes it bigger (left in Arabic text). */
  private drag(start: PointerEvent) {
    start.preventDefault();
    const handle = start.target as HTMLElement;
    handle.setPointerCapture(start.pointerId);
    const rtl = getComputedStyle(this.dom).direction === "rtl";
    const startWidth = this.img.getBoundingClientRect().width;
    const max = this.pageWidth();
    let width = startWidth;
    const move = (e: PointerEvent) => {
      const dx = (e.clientX - start.clientX) * (rtl ? -1 : 1);
      width = Math.round(Math.min(max, Math.max(MIN_WIDTH, startWidth + dx)));
      this.img.style.width = `${width}px`;
    };
    const up = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
      if (width !== Math.round(startWidth)) this.setWidth(width);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
  }

  update(node: PMNode) {
    if (node.type !== this.node.type) return false;
    this.node = node;
    this.render();
    return true;
  }

  selectNode() {
    this.dom.classList.add("is-selected");
  }

  deselectNode() {
    this.dom.classList.remove("is-selected");
  }

  // The handle and the size bar are the image's own controls, not editable text.
  stopEvent(event: Event) {
    return !!(event.target as HTMLElement).closest?.(".image-handle, .image-bar");
  }

  ignoreMutation() {
    return true;
  }
}
