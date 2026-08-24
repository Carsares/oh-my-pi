const DEFAULT_MAX_ROWS = 5;
const DEFAULT_MIN_ROWS = 2;
const FALLBACK_FONT_SIZE = 16;
const FALLBACK_LINE_HEIGHT_RATIO = 1.45;

function parsePixelValue(value) {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function resolveLineHeight(style) {
  const lineHeight = parsePixelValue(style.lineHeight);
  if (lineHeight > 0) return lineHeight;

  const fontSize = parsePixelValue(style.fontSize) || FALLBACK_FONT_SIZE;
  return fontSize * FALLBACK_LINE_HEIGHT_RATIO;
}

function resolveBoxHeightForRows(input, rows) {
  const style = getComputedStyle(input);
  const lineHeight = resolveLineHeight(style);
  const verticalPadding = parsePixelValue(style.paddingTop) + parsePixelValue(style.paddingBottom);
  const verticalBorder =
    parsePixelValue(style.borderTopWidth) + parsePixelValue(style.borderBottomWidth);

  return Math.ceil(lineHeight * rows + verticalPadding + verticalBorder);
}

export function setupComposerAutoResize({
  input,
  minRows = DEFAULT_MIN_ROWS,
  maxRows = DEFAULT_MAX_ROWS,
} = {}) {
  if (!input) return { dispose() {}, sync() {} };

  const minHeight = () => resolveBoxHeightForRows(input, minRows);
  const maxHeight = () => resolveBoxHeightForRows(input, maxRows);

  const sync = () => {
    input.style.height = "auto";
    const nextHeight = Math.max(minHeight(), Math.min(input.scrollHeight, maxHeight()));
    input.style.height = `${nextHeight}px`;
    input.style.overflowY = input.scrollHeight > maxHeight() ? "auto" : "hidden";
  };

  input.addEventListener("input", sync);
  sync();

  return {
    dispose() {
      input.removeEventListener("input", sync);
    },
    sync,
  };
}
