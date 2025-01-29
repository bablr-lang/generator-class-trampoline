import { Coroutine } from '@bablr/coroutine';
import { getProduction } from '@bablr/helpers/grammar';
import {
  buildBasicNodeMatcher,
  buildCall,
  buildTuple,
  buildTupleValues,
  buildPropertyMatcher,
  buildSpamMatcher,
  buildObject,
  buildObjectProperties,
  buildIdentifier,
  buildProperty,
  buildExpression,
} from '@bablr/helpers/builders';

const { freeze } = Object;

export const coroutines = new WeakMap();

function* defaultFragment({ value: { productionName } }) {
  yield buildCall(
    buildIdentifier('eat'),
    buildTuple(
      buildTupleValues([
        buildPropertyMatcher(
          null,
          buildBasicNodeMatcher(buildSpamMatcher(buildIdentifier(productionName), undefined)),
        ),
      ]),
    ),
  );
}

export const buildCoroutine = (ctx, s, m, value = null, intrinsicValue = null) => {
  const { grammars, productionEnhancer } = ctx;
  const { propertyMatcher, language } = m;
  const { nodeMatcher } = propertyMatcher;
  const { type } = nodeMatcher.open;
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
  const attributes = buildObject(
    buildObjectProperties(
      Object.entries(nodeMatcher.open.attributes || {}).map(([k, v]) =>
        buildProperty(buildIdentifier(k), buildExpression(v)),
      ),
    ),
  );

  const props = freeze({
    value,
    state: s,
    s,
    grammar,
    context: ctx,
    ctx,
    attributes,
    attrs: attributes,
    intrinsicValue,
  });

  const co = new Coroutine(enhancedProduction.call(grammar, props));

  if (!co.generator) {
    throw new Error('Production was not a generator');
  }

  coroutines.set(m, co);

  return co;
};
