export async function resolve(specifier, context, nextResolve) {
  if (specifier.endsWith('models/Counter.js')) {
    return {
      url: new URL('./fakeCounter.mjs', import.meta.url).href,
      shortCircuit: true,
    };
  }
  return nextResolve(specifier, context);
}
