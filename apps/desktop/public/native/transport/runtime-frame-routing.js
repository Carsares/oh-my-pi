// Classifies runtime frames while preserving the foreground sequence watermark.

export function routeRuntimeFrame({
  frame,
  target,
  store,
  consumeConfigResponse,
  reduceForeground,
}) {
  const configResponseConsumed = consumeConfigResponse(frame);
  const isBackground =
    frame.target.instanceId !== target.instanceId ||
    (frame.target.sessionId && frame.target.sessionId !== target.sessionId);

  if (isBackground) {
    return {
      kind: configResponseConsumed ? "consumed-background" : "background",
      store,
    };
  }

  return {
    kind: configResponseConsumed ? "consumed-foreground" : "foreground",
    store: reduceForeground(store, frame),
  };
}
