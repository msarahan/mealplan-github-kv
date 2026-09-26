// Single place to change the model when Anthropic retires one. The Worker overrides
// whatever model the frontend sends, so /generate follows this too.
// (Lives outside index.ts: the Workers runtime rejects non-handler value exports
// from the main module.)
export const MODEL = 'claude-opus-5';
