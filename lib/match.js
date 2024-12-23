import { Coroutine } from '@bablr/coroutine';
import { getProduction, resolveLanguage } from '@bablr/helpers/grammar';
import {
  buildAttribute,
  buildBasicNodeMatcher,
  buildCall,
  buildTuple,
  buildTupleValues,
  buildPropertyMatcher,
  buildSpamMatcher,
  buildIdentifier,
} from '@bablr/agast-vm-helpers';
import * as sym from '@bablr/agast-helpers/symbols';

const { freeze } = Object;

export const coroutines = new WeakMap();

function* defaultFragment() {
  yield buildCall(
    buildIdentifier('eat'),
    buildTuple(
      buildTupleValues([
        buildPropertyMatcher(
          null,
          buildBasicNodeMatcher(buildSpamMatcher('?', undefined, sym.gap)),
        ),
      ]),
    ),
  );
}

export const buildCoroutine = (ctx, s, m, value = null, intrinsicValue = null) => {
  const { grammars, productionEnhancer } = ctx;
  const { propertyMatcher } = m;
  const { nodeMatcher } = propertyMatcher;
  const { type } = nodeMatcher.open;
  const language = resolveLanguage(ctx, m.language, nodeMatcher.open.language);
  const grammar = grammars.get(language);
  const resolvedType = type === null ? Symbol.for('@bablr/fragment') : type;

  let production = getProduction(grammar, resolvedType);

  if (!production) {
    if (resolvedType === Symbol.for('@bablr/fragment')) {
      production = defaultFragment;
    } else {
      throw new Error(`Unknown production {type: ${type}}`);
    }
  }

  const enhancedProduction = productionEnhancer ? productionEnhancer(production, type) : production;

  const props = freeze({
    value,
    state: s,
    s,
    grammar,
    context: ctx,
    ctx,
    attributes: Object.freeze(
      Object.fromEntries(
        Object.entries(nodeMatcher.attributes || {}).map(([k, v]) => buildAttribute(k, v)),
      ),
    ),
    intrinsicValue,
  });

  const co = new Coroutine(enhancedProduction.call(grammar, props));

  if (!co.generator) {
    throw new Error('Production was not a generator');
  }

  coroutines.set(m, co);

  return co;
};
