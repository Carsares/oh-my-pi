// The runtime model metadata is authoritative. A reasoning model without an
// effort ladder may reason internally, but the client has nothing to adjust.
export function canAdjustModelThinking(model) {
  return (
    model?.reasoning === true &&
    Array.isArray(model.thinking?.efforts) &&
    model.thinking.efforts.length > 0
  );
}
