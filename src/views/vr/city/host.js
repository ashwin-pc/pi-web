// Where the City mounts in pi-web (set by vrApp.ts before any City module is evaluated): the root-view element, and
// the way back to the 2D app.
export const host = {el: null, exit: () => location.assign('/')};
