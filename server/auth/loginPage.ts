// Shared presentation and browser ceremony for all public sign-in/setup routes.
// Authentication policy, challenges, and session creation remain in their route handlers.
const escapeHtml = (value: string) => value.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const scriptValue = (value: unknown) => JSON.stringify(value).replace(/</g, "\\u003c");

// Public presentation assets only; authenticated APIs remain behind their existing gate.
export const loginPageHeaders = {
  "content-type": "text/html; charset=utf-8",
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
  "content-security-policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'self' 'unsafe-inline'; media-src 'self'; img-src 'self'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'",
};

const styles = `
/* Self-contained: public auth cannot depend on authenticated app assets/settings.
   Defaults mirror src/styles/base.css; geometry follows native settings panels. */
:root{color-scheme:dark;--bg:#030303;--panel:#0a0a0a;--panel-2:#131313;--border:#242424;--text:#f2f2f2;--muted:#a3a3a3;--accent:#e2b15f;--danger:#fb7185}
*{box-sizing:border-box}body{margin:0;background:radial-gradient(circle at 50% -12rem,rgba(54,54,54,.62),transparent 44rem),var(--bg);color:var(--text);font:15px/1.5 ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;min-height:100svh;display:grid;place-items:center;padding:32px 16px}
main{width:min(420px,100%);min-width:0;padding:28px}.newChatLoadingAnimation{display:block;margin:0 auto}.avatarStill{display:none}
label{color:var(--muted);font-size:12px}h1{font-size:24px;line-height:1.12;letter-spacing:-.025em;margin:12px 0 32px;text-align:center}h2{font-size:17px;margin:0 0 8px}p{color:var(--muted);font-size:13px;line-height:1.5;margin:0 0 22px}
button,input,.button{width:100%;min-height:44px;font:inherit;font-size:13px;border-radius:9px;padding:10px 12px;border:1px solid var(--border);background:var(--panel-2);color:var(--text)}button,.button{cursor:pointer;font-weight:650;text-align:center;display:block;text-decoration:none}button:hover:not(:disabled),.button:hover{border-color:var(--accent)}
.primary{background:color-mix(in srgb,var(--accent) 12%,var(--panel));border-color:color-mix(in srgb,var(--accent) 48%,var(--border));color:var(--accent)}.primary:hover:not(:disabled){background:color-mix(in srgb,var(--accent) 18%,var(--panel))}.secondary{margin-top:10px}button:disabled{opacity:.45;cursor:wait}button:focus-visible,a:focus-visible,summary:focus-visible,input:focus-visible{outline:2px solid var(--accent);outline-offset:3px}
input{display:block;margin:6px 0 12px;background:var(--bg);font-size:16px}form{margin-top:16px}form[hidden]{display:none}#status{color:var(--accent);font-size:12px;margin:12px 0 0;overflow-wrap:anywhere}#status:empty{display:none}#status.error{color:var(--danger)}details{margin-top:12px;color:var(--muted);font-size:12px}summary{cursor:pointer;padding:12px;text-align:center}details button{margin-top:8px}.back{display:block;color:var(--accent);font-size:12px;text-align:center;margin-top:16px}noscript{display:block;color:var(--danger);margin-top:16px}
@media(max-width:480px){body{padding:20px 16px}main{padding:22px}}@media(prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}video.newChatLoadingAnimation{display:none}.avatarStill{display:block}}
`;

export function renderLoginPage(options: { methods: readonly string[]; setupToken?: string; passkeyOnly?: boolean }) {
  const { methods, setupToken, passkeyOnly = false } = options;
  const setup = setupToken !== undefined;
  const hasPasskey = methods.includes("passkey");
  const hasPassword = methods.includes("password") && !passkeyOnly;
  const form = (method: string, label: string, hidden = false) => `<form id="${method}" data-method="${method}" ${hidden ? "hidden" : ""}><label for="${method}-secret">${label}</label><input id="${method}-secret" name="secret" type="password" autocomplete="${setup ? "new-password" : method === "password" ? "current-password" : "off"}" ${setup ? 'minlength="12" maxlength="1024"' : ""} required>${setup ? '<label for="confirm">Confirm password</label><input id="confirm" name="confirm" type="password" autocomplete="new-password" required>' : ""}<button class="primary">${setup ? "Set password" : "Sign in"}</button></form>`;
  const passkey = !hasPasskey ? "" : setup && !passkeyOnly
    ? `<a class="button primary" href="/api/auth/passkey-bootstrap?token=${escapeHtml(encodeURIComponent(setupToken!))}">Set up a passkey</a>`
    : `${setup ? '<label for="name">Credential name</label><input id="name" value="Primary passkey" maxlength="80" autocomplete="off">' : ""}<button class="primary" id="go">${setup ? "Create passkey" : "Sign in with passkey"}</button>`;
  const alternatives = !setup && !passkeyOnly ? [
    methods.includes("external") ? '<form data-method="external"><button>Continue with trusted proxy</button></form>' : "",
    methods.includes("legacy") ? form("legacy", "Legacy token (deprecated)") : "",
  ].join("") : "";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>Pi Web</title><link rel="stylesheet" href="/new-chat-animation.css"><style>${styles}</style></head><body><main><video class="newChatLoadingAnimation" muted playsinline preload="auto" aria-hidden="true"><source src="/new-chat-loading.webm" type='video/webm; codecs="vp8"'><source src="/new-chat-loading.mp4" type='video/mp4; codecs="avc1.64001e"'></video><img class="newChatLoadingAnimation avatarStill" src="/new-chat-still.png" alt="" aria-hidden="true"><h1>Pi Web</h1>${setup ? `<h2>${passkeyOnly ? "Enroll a passkey" : "Set up your workspace"}</h2><p>Choose a sign-in method for your private workspace. Keep a backup credential and terminal recovery access.</p>` : ""}${passkey}${hasPassword && hasPasskey && !setup ? '<button class="secondary" id="passwordToggle" aria-expanded="false" aria-controls="password">Use a password</button>' : ""}${hasPassword ? form("password", setup ? "New password (12+ characters)" : "Password", hasPasskey && !setup) : ""}${alternatives ? `<details><summary>Other ways to sign in</summary>${alternatives}</details>` : ""}${!methods.length ? '<p>No sign-in method is available. Use terminal recovery to restore access.</p>' : ""}${passkeyOnly && !setup ? '<a class="back" href="/api/auth/login">Other sign-in methods</a>' : ""}<p id="status" role="status" aria-live="polite" aria-atomic="true"></p><noscript>JavaScript is required to sign in. Enable it and reload this page.</noscript></main><script>
const statusElement=document.getElementById('status'),go=document.getElementById('go'),setup=${scriptValue(setup)},setupToken=${scriptValue(setupToken || "")};
const report=(message,error=false)=>{statusElement.textContent=message;statusElement.classList.toggle('error',error)};
// The same entry video and presentation as New Session; no app bootstrap or API dependency.
const avatar=document.querySelector('video'),motion=matchMedia('(prefers-reduced-motion: reduce)');
const syncMotion=()=>{if(motion.matches)avatar.pause();else void avatar.play().catch(()=>{})};
motion.addEventListener('change',syncMotion);syncMotion();
if(!window.isSecureContext)report('Unencrypted connection. Use HTTPS for remote sign-in.',true);
const toggle=document.getElementById('passwordToggle');if(toggle)toggle.onclick=()=>{const f=document.getElementById('password');f.hidden=!f.hidden;toggle.setAttribute('aria-expanded',String(!f.hidden));if(!f.hidden)f.elements.secret.focus()};
const post=async(path,body,headers={})=>{const r=await fetch(path,{method:'POST',headers:{'content-type':'application/json',...headers},body:JSON.stringify(body)});const value=await r.json().catch(()=>({}));if(!r.ok)throw Error(value.error||'Request failed ('+r.status+')');return value};
let busy=false;const run=async(action,message)=>{if(busy)return;busy=true;document.querySelectorAll('button').forEach(b=>b.disabled=true);report(message);try{await action()}catch(error){report(error.name==='NotAllowedError'?'Passkey request cancelled or unavailable. Try again, or choose another sign-in method.':error.message||'Unable to sign in. Please try again.',true)}finally{busy=false;document.querySelectorAll('button').forEach(b=>b.disabled=false)}};
document.querySelectorAll('form').forEach(f=>f.addEventListener('submit',event=>{event.preventDefault();run(async()=>{if(setup&&f.elements.secret.value!==f.elements.confirm.value)throw Error('Passwords do not match');await post('/api/auth/'+f.dataset.method+(setup?'/bootstrap':'/login'),{password:f.elements.secret?.value,token:setupToken});location.href='/'},setup?'Setting up your workspace…':'Signing in…')}));
const decode=v=>Uint8Array.from(atob(v.replace(/-/g,'+').replace(/_/g,'/')),c=>c.charCodeAt(0)),encode=v=>btoa(String.fromCharCode(...new Uint8Array(v))).replace(/\\+/g,'-').replace(/\\//g,'_').replace(/=+$/,'');
if(go)go.onclick=()=>run(async()=>{if(!window.isSecureContext||!window.PublicKeyCredential)throw Error('Passkeys require a supported browser on HTTPS or localhost. Choose another sign-in method.');const name=document.getElementById('name')?.value||'Passkey';const o=await post(setup?'/api/auth/bootstrap/options':'/api/auth/passkey/options',setup?{token:setupToken,name}:{});o.challenge=decode(o.challenge);if(setup){o.user.id=decode(o.user.id);o.excludeCredentials?.forEach(x=>x.id=decode(x.id))}else{o.allowCredentials?.forEach(x=>x.id=decode(x.id))}const c=setup?await navigator.credentials.create({publicKey:o}):await navigator.credentials.get({publicKey:o});if(!c)throw Error('Passkey request cancelled. Please try again.');const response={id:c.id,rawId:encode(c.rawId),type:c.type,response:{clientDataJSON:encode(c.response.clientDataJSON),authenticatorData:c.response.authenticatorData&&encode(c.response.authenticatorData),signature:c.response.signature&&encode(c.response.signature),userHandle:c.response.userHandle&&encode(c.response.userHandle),attestationObject:c.response.attestationObject&&encode(c.response.attestationObject)},clientExtensionResults:c.getClientExtensionResults()};await post(setup?'/api/auth/bootstrap/verify':'/api/auth/passkey/verify',setup?{response,name}:response);location.href='/'},'Waiting for your device’s passkey prompt…');
</script></body></html>`;
}
