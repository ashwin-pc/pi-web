// Where the City mounts in pi-web (set by vrApp.ts before any City module is evaluated): the root-view element, the
// way back to the 2D app, loading an artifact's content (round 3), and opening one in the 2D viewer.
export const host = {el: null, exit: () => location.assign('/'), loadArtifact: null, openIn2D: null};
