import { useEffect, useRef } from 'preact/hooks';

// Typed access to the VS Code webview API (acquireVsCodeApi may be called only once per webview)
declare function acquireVsCodeApi(): {
	postMessage(message: unknown): void;
	getState(): unknown;
	setState(state: unknown): void;
};

const api = acquireVsCodeApi();

/** Send a message to the extension. `Out` is the webview → extension union from src/protocol.ts */
export function createPoster<Out>() {
	return (message: Out) => api.postMessage(message);
}

/** Run `handler` for every message from the extension (always the latest handler, subscribed once) */
export function useHostMessage<In>(handler: (message: In) => void) {
	const latest = useRef(handler);
	latest.current = handler;
	useEffect(() => {
		const listener = (event: MessageEvent<In>) => latest.current(event.data);
		window.addEventListener('message', listener);
		return () => window.removeEventListener('message', listener);
	}, []);
}
