// Tauri isn't there in a plain browser: the composer's drop listener does nothing.
export const getCurrentWebview = () => ({ onDragDropEvent: async () => () => {} });
