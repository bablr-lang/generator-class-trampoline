import isString from 'iter-tools-es/methods/is-string';
import emptyStack from '@iter-tools/imm-stack';
import { Coroutine } from '@bablr/coroutine';
import { getProduction, resolveLanguage } from '@bablr/helpers/grammar';
import { isEmpty } from '@bablr/agast-helpers/stream';
import { WeakStackFrame } from '@bablr/weak-stack';
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
import {
  buildFragmentCloseTag,
  buildFragmentOpenTag,
  buildReferenceTag,
  referenceFlags,
} from '@bablr/agast-helpers/builders';
import { ReferenceTag, OpenNodeTag, CloseNodeTag, NullTag } from '@bablr/agast-helpers/symbols';
import * as sym from '@bablr/agast-helpers/symbols';
import * as btree from '@bablr/agast-helpers/btree';
import { TagPath } from '@bablr/agast-helpers/path';

const nodeTopType = Symbol.for('@bablr/node');
const { freeze } = Object;

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

const states = new WeakMap();

export class FragmentFacade {
  constructor(range, dotPropertyName) {
    const {
      0: { path: startPath, childrenIndex: startChildrenIndex },
      1: { path: endPath, childrenIndex: endChildrenIndex },
    } = range;

    if (!range[0].child || !range[1].child) {
      throw new Error();
    }

    let childrenIndexRange = null;
    let path = null;

    let isNode = range[0].child.type === OpenNodeTag;
    let isNull = range[0].child.type === NullTag;

    if (startPath.node === endPath.node) {
      childrenIndexRange = [startChildrenIndex, endChildrenIndex];
      path = startPath;
    } else if (
      startPath.depth === endPath.depth - 1 &&
      startPath.node === endPath.parent.node &&
      [CloseNodeTag, NullTag].includes(range[1].child.type)
    ) {
      childrenIndexRange = [startChildrenIndex, endPath.referenceIndex];
      path = startPath;
    } else {
      throw new Error();
    }

    if (childrenIndexRange[0] == null || childrenIndexRange[1] == null) {
      throw new Error();
    }

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

  get(name, index) {
    let { path, dotPropertyName } = states.get(this);

    if (!this.isNode) {
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

    let openTag = new TagPath(newPath, 0);
    let closeTag = new TagPath(newPath, btree.getSum(newPath.node.children) - 1);

    return new FragmentFacade([openTag, closeTag], name);
  }

  has(path) {
    throw new Error('not implemented');
  }
}

Object.seal(FragmentFacade);

export class Match extends WeakStackFrame {
  constructor(
    parent,
    context,
    language,
    state,
    matcher = null,
    effects = null,
    co = null,
    languageRelativePath = emptyStack,
    declaredPath = null,
  ) {
    if (!context || !language || !state) {
      throw new Error('Invalid arguments to Match constructor');
    }

    super(parent);

    this.context = context;
    this.language = language;
    this.languageRelativePath = languageRelativePath;
    this.state = state;
    this.propertyMatcher = matcher;
    this.declaredPath = declaredPath;
    this.effects = effects;
    this.co = co;

    this.path = state.path;
    this.leftSkewedRange = [];
  }

  static from(context, language, state) {
    return Match.create(context, language, state);
  }

  get matcher() {
    return this.propertyMatcher?.nodeMatcher;
  }

  get pathName() {
    return this.matcher.refMatcher.name;
  }

  get ctx() {
    return this.context;
  }

  get grammar() {
    return this.context.grammars.get(this.language);
  }

  get s() {
    return this.state;
  }

  get type() {
    return this.matcher?.type || null;
  }

  get flags() {
    return this.matcher?.flags;
  }

  get captured() {
    return this.zombie || !!this.leftSkewedRange[1];
  }

  get zombie() {
    return !this.leftSkewedRange;
  }

  get openTagPath() {
    const previousTag = this.leftSkewedRange?.[0];

    return previousTag?.next;
  }

  get closeTagPath() {
    return this.leftSkewedRange?.[1];
  }

  get range() {
    const { openTagPath, closeTagPath } = this;
    return this.leftSkewedRange === null ? null : [openTagPath, closeTagPath];
  }

  get empty() {
    const { range, ctx } = this;

    return isEmpty(ctx.agast.allTagsFor(range));
  }

  get isNode() {
    const { grammar, type } = this;
    return grammar.covers?.get(nodeTopType).has(type);
  }

  get isCover() {
    const { grammar, type } = this;
    return grammar.covers?.has(type);
  }

  exec(state, effects, propertyMatcher, value, intrinsicValue) {
    let { ctx, languageRelativePath, declaredPath } = this;
    const { grammars, productionEnhancer } = ctx;
    const { nodeMatcher } = propertyMatcher;
    const { type } = nodeMatcher.open;

    const language = resolveLanguage(ctx, this.language, nodeMatcher.language);
    const grammar = grammars.get(language);
    const isNode = grammar.covers?.get(nodeTopType).has(type);
    const isCover = grammar.covers.has(type);

    if (!language) {
      throw new Error(`Unknown language ${nodeMatcher.language}`);
    }

    const resolvedType = type === null ? Symbol.for('@bablr/fragment') : type;

    let production = getProduction(grammar, resolvedType);

    if (!production) {
      if (resolvedType === Symbol.for('@bablr/fragment')) {
        production = defaultFragment;
      } else {
        throw new Error(`Unknown production {type: ${type}}`);
      }
    }

    const enhancedProduction = productionEnhancer
      ? productionEnhancer(production, type)
      : production;

    const props = freeze({
      value,
      state,
      s: state,
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

    languageRelativePath =
      isNode || isString(nodeMatcher.language)
        ? emptyStack
        : nodeMatcher.language
        ? languageRelativePath.push(nodeMatcher.language)
        : languageRelativePath;

    const match = this.push(
      ctx,
      language,
      state,
      propertyMatcher,
      effects,
      co,
      languageRelativePath,
      isNode ? undefined : declaredPath,
    );

    return match;
  }
}
