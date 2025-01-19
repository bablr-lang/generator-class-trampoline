import { Coroutine } from '@bablr/coroutine';
import { getProduction } from '@bablr/helpers/grammar';
import * as btree from '@bablr/agast-helpers/btree';
import {
  buildAttribute,
  buildBasicNodeMatcher,
  buildCall,
  buildTuple,
  buildTupleValues,
  buildPropertyMatcher,
  buildSpamMatcher,
  buildIdentifier,
  buildExpression,
  buildAttributes,
} from '@bablr/agast-vm-helpers';
import {
  buildFragmentCloseTag,
  buildFragmentOpenTag,
  buildReferenceTag,
  referenceFlags,
} from '@bablr/agast-helpers/builders';
import { NullTag, OpenNodeTag, ReferenceTag } from '@bablr/agast-helpers/symbols';
import * as sym from '@bablr/agast-helpers/symbols';

const { freeze } = Object;

export const coroutines = new WeakMap();

const states = new WeakMap();

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
  const attributes = buildAttributes(
    Object.entries(nodeMatcher.open.attributes || {}).map(([k, v]) =>
      buildAttribute(buildIdentifier(k), buildExpression(v)),
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

export class FragmentFacade {
  constructor(path, childrenIndexRange, dotPropertyName) {
    if (childrenIndexRange[0] == null || !childrenIndexRange[1] == null) {
      throw new Error();
    }

    const openTag = btree.getAt(childrenIndexRange[0], path.node.children);

    let isNode = openTag.type === OpenNodeTag;
    let isNull = openTag.type === NullTag;

    states.set(this, {
      openTag: isNode || isNull ? null : buildFragmentOpenTag(),
      closeTag: isNode || isNull ? null : buildFragmentCloseTag(),
      path,
      childrenIndexRange,
      dotPropertyName,
    });
  }

  get isTransparent() {
    return true;
  }

  get isNode() {
    const { openTag } = this;
    return openTag.type === OpenNodeTag;
  }

  get children() {
    const { path, childrenIndexRange, openTag, closeTag } = states.get(this);

    return {
      *[Symbol.iterator]() {
        if (openTag) yield openTag;

        if (childrenIndexRange[0] > childrenIndexRange[1]) throw new Error();

        for (let i = childrenIndexRange[0]; i <= childrenIndexRange[1]; i++) {
          yield btree.getAt(i, path.node.children);
        }

        if (closeTag) yield closeTag;
      },
    };
  }

  get flags() {
    const { openTag } = this;

    return openTag.type === OpenNodeTag
      ? openTag.value.flags
      : openTag.type === sym.OpenFragmentTag
      ? // redundant value accessor for monomorphism
        openTag.value.flags
      : null;
  }

  get language() {
    const { openTag } = this;

    return openTag.type === OpenNodeTag ? openTag.value.language : null;
  }

  get type() {
    const { openTag } = this;

    return openTag.type === OpenNodeTag
      ? openTag.value.type
      : openTag.type === NullTag
      ? sym.null
      : null;
  }

  get attributes() {
    return this.openTag.attributes;
  }

  get openTag() {
    const state = states.get(this);
    const { children } = state.path.node;

    // ???
    return state.openTag || btree.getAt(0, children);
  }

  get closeTag() {
    const state = states.get(this);
    const { children } = state.path.node;

    return state.closeTag || btree.getAt(btree.getSum(children) - 1, children);
  }

  getRootIndex() {
    const { path, dotPropertyName, childrenIndexRange } = states.get(this);
    const { node } = path;

    if (childrenIndexRange[0] > childrenIndexRange[1]) throw new Error();

    for (let i = childrenIndexRange[0]; i <= childrenIndexRange[1]; i++) {
      let tag = btree.getAt(i, node.children);
      if (tag.type === ReferenceTag) {
        const { name, isArray } = tag.value;
        let resolvedTagName = name === '.' ? dotPropertyName : name;

        if (resolvedTagName === dotPropertyName) {
          return i;
        }
      }
    }

    return null;
  }

  get(name, index = null) {
    let { path, dotPropertyName } = states.get(this);

    if (dotPropertyName) {
      let dotChildrenIndex = this.getRootIndex();
      let dotIndex = path.referenceIndexes[dotChildrenIndex];
      let dotReference = buildReferenceTag(
        dotPropertyName,
        dotIndex != null,
        referenceFlags,
        dotIndex,
      );

      path = path.get(dotReference);
    }

    let newPath = path.get(buildReferenceTag(name, index != null, referenceFlags, index));

    // if (newPath.node.type === sym.null) throw new Error();

    return new FragmentFacade(newPath, [0, btree.getSum(newPath.node.children) - 1], null);
  }

  has(path) {
    throw new Error('not implemented');
  }
}

Object.seal(FragmentFacade);
