/** True when the frontend runs inside the browser-based Web Host build
 *  (`vite --mode web`) instead of the Tauri desktop shell. */
export const isWebHost = import.meta.env.MODE === "web";
