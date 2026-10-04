/** Copy the final native spawn environment without pi-web's host control token.
 * Preserve native auth/config and the caller's environment, including Windows
 * key aliases. This is credential separation, not an OS sandbox or an allowlist.
 */
export function nativeChildEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = Object.create(null);
  // Node spawn includes enumerable inherited keys too; never inherit a token
  // again through the output object's prototype.
  for (const key in environment) {
    if (key.toUpperCase() !== "PI_WEB_TOKEN") result[key] = environment[key];
  }
  return result;
}
