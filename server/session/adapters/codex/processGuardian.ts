/** Unix group leader stays alive through native-wrapper exit and final escalation.
 * The leader's PID cannot be recycled while it anchors the group. Native stderr
 * and protocol stdout stay on inherited pipes; IPC is private guardian control. */
export const processGuardian = String.raw`
const {spawn} = require('node:child_process');
process.on('SIGTERM', () => {});
process.on('SIGINT', () => {});
const anchor = setInterval(() => {}, 1000);
const native = spawn(process.argv[1], JSON.parse(process.argv[2]), {stdio:['pipe', 'inherit', 'inherit']});
process.stdin.pipe(native.stdin);
native.stdin.on('error', () => {});
native.once('error', () => process.send?.({type:'native-exit', launchError:true}));
native.once('exit', (code, signal) => process.send?.({type:'native-exit', code, signal}));
process.on('disconnect', () => { try { process.kill(-process.pid, 'SIGKILL'); } catch {} });
`;
