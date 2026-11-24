// Where the drawing sheet is seen from: how close (screen pixels per mm of
// paper) and which point of the paper is in the middle of the screen. The
// sheet is shown through its SVG viewBox, so lines stay sharp at any zoom and
// moving round never redraws the sheet.

export class SheetCamera {
  /** Pixels per mm. */
  z = 1;
  /** The paper point (mm) in the middle of the screen. */
  cx = 0;
  cy = 0;
  /** Showing all of the sheet (and kept so when the window or sheet changes size). */
  fitted = true;
  /** The screen area (px) and the sheet (mm). */
  vw = 1;
  vh = 1;
  sheetWidth = 420;
  sheetHeight = 297;

  /** Room round the sheet when it is all in view (px). */
  static MARGIN = 16;

  /** Pixels per mm with all of the sheet in view. */
  fitZoom(): number {
    const margin = SheetCamera.MARGIN;

    return Math.max(1e-3, Math.min((this.vw - 2 * margin) / this.sheetWidth, (this.vh - 2 * margin) / this.sheetHeight));
  }
  /** How far it may go: a quarter of the whole sheet out, 60 times in (and at least 40 px a mm). */
  minZoom(): number {
    return this.fitZoom() / 4;
  }
  maxZoom(): number {
    return Math.max(this.fitZoom() * 60, 40);
  }

  /** All of the sheet, in the middle. */
  fit(): void {
    this.z = this.fitZoom();
    this.cx = this.sheetWidth / 2;
    this.cy = this.sheetHeight / 2;
    this.fitted = true;
  }

  /** The screen area changed size: still all of the sheet if it was, else the same middle and zoom. */
  resize(vw: number, vh: number): void {
    this.vw = Math.max(1, vw);
    this.vh = Math.max(1, vh);
    if (this.fitted) {
      this.fit();
    } else {
      this.clamp();
    }
  }

  /** Another sheet size (A3 to A4…): all of it. */
  setSheet(sheetWidth: number, sheetHeight: number): void {
    if (sheetWidth === this.sheetWidth && sheetHeight === this.sheetHeight) {
      return;
    }
    this.sheetWidth = sheetWidth;
    this.sheetHeight = sheetHeight;
    this.fit();
  }

  /** A screen point (px from the area's top left) on the paper (mm). */
  toPaper(px: number, py: number): [number, number] {
    return [this.cx + (px - this.vw / 2) / this.z, this.cy + (py - this.vh / 2) / this.z];
  }
  /** A paper point on the screen. */
  toScreen(x: number, y: number): [number, number] {
    return [this.vw / 2 + (x - this.cx) * this.z, this.vh / 2 + (y - this.cy) * this.z];
  }

  /** Closer (`factor` > 1) or further, keeping the paper under the screen point where it is. */
  zoomAt(px: number, py: number, factor: number): void {
    const [x, y] = this.toPaper(px, py);
    this.z = Math.min(this.maxZoom(), Math.max(this.minZoom(), this.z * factor));
    this.cx = x - (px - this.vw / 2) / this.z;
    this.cy = y - (py - this.vh / 2) / this.z;
    this.fitted = false;
    this.clamp();
  }

  /** The paper moved with the finger by (dx, dy) screen pixels. */
  panBy(dx: number, dy: number): void {
    this.cx -= dx / this.z;
    this.cy -= dy / this.z;
    this.fitted = false;
    this.clamp();
  }

  /** The sheet never goes out of sight: the middle of the screen stays over it. */
  clamp(): void {
    this.cx = Math.min(this.sheetWidth, Math.max(0, this.cx));
    this.cy = Math.min(this.sheetHeight, Math.max(0, this.cy));
  }

  /** How close, against all of the sheet in view (1: fitted). */
  ratio(): number {
    return this.z / this.fitZoom();
  }

  /** The SVG viewBox for what's in view. */
  viewBox(): string {
    const width = this.vw / this.z;
    const height = this.vh / this.z;
    const round4 = (value: number) => Math.round(value * 1e4) / 1e4;

    return `${round4(this.cx - width / 2)} ${round4(this.cy - height / 2)} ${round4(width)} ${round4(height)}`;
  }

  /** The state, to go smoothly from one to another. */
  get state(): { z: number; cx: number; cy: number } {
    return { z: this.z, cx: this.cx, cy: this.cy };
  }
  /** Part way (t: 0 to 1) from one state to another: zoom evenly in scale, the middle so the view glides. */
  blend(a: { z: number; cx: number; cy: number }, b: { z: number; cx: number; cy: number }, t: number): void {
    this.z = a.z * Math.pow(b.z / a.z, t);
    this.cx = a.cx + (b.cx - a.cx) * t;
    this.cy = a.cy + (b.cy - a.cy) * t;
  }
}
