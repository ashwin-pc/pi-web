// The one module the City reads data through (sessions, transcripts, events, the file tree, actions). In the mock it
// was backed by fixtures; here it is a live binding to the adapter over pi-web's client state layer
// (src/views/vr/cityClient.ts), installed by vrApp.ts before any City module is evaluated.
export let client = null;
export function installClient(value) { client = value; }
