import isString from 'iter-tools-es/methods/is-string';
import emptyStack from '@iter-tools/imm-stack';
import { Coroutine } from '@bablr/coroutine';
import { getProduction, resolveLanguage } from '@bablr/helpers/grammar';
import { isEmpty } from '@bablr/agast-helpers/stream';
import { WeakStackFrame } from '@bablr/weak-stack';
import { buildAttribute, buildCall, buildSpamMatcher } from '@bablr/helpers/builders';
import {
  buildFragmentCloseTag,
  buildFragmentOpenTag,
  wrapFragment,
} from '@bablr/agast-helpers/builders';
import { OpenNodeTag, ReferenceTag } from '@bablr/agast-helpers/symbols';
import { facades, actuals } from './facades.js';

const nodeTopType = Symbol.for('@bablr/node');
const { freeze } = Object;

function* defaultFragment() {
  yield wrapFragment(buildCall('eat', buildSpamMatcher()));
}

const openTags = new WeakMap();
const closeTags = new WeakMap();
const rootPropertyNames = new WeakMap();

export class MatchFragmentFacade {
  constructor(match) {
    facades.set(match, this);
    openTags.set(this, buildFragmentOpenTag(this.flags));
    closeTags.set(this, buildFragmentCloseTag());
    rootPropertyNames.set(
      this,
      match.declaredPath?.name || match.path.reference?.value.name || '.',
    );
  }

  get isTransparent() {
    return true;
  }

  get children() {
    const m = actuals.get(this);
    const openTag = openTags.get(this);
    const closeTag = closeTags.get(this);
    return {
      *[Symbol.iterator]() {
        const { context: ctx, range, type, grammar, s } = m;
        const isNode = grammar.covers?.get(Symbol.for('@bablr/node')).has(type);

        let tag = range[0];

        yield openTag;

        while (tag && tag !== closeTag) {
          if ((!isNode || tag !== openTag) && tag.type === OpenNodeTag) {
            let node = s.nodeForTag(tag);
            tag = node.closeTag;

            if (!isNode || tag !== closeTag) {
              tag = ctx.agast.getNextTag(tag);
            }
            continue;
          }

          yield tag;

          tag = ctx.agast.getNextTag(tag);
        }

        yield closeTag;
      },
    };
  }

  get flags() {
    return actuals.get(this).matcher.flags;
  }

  get language() {
    return actuals.get(this).matcher.language;
  }

  get type() {
    return actuals.get(this).matcher.type;
  }

  get attributes() {
    return actuals.get(this).matcher.attributes;
  }

  get openTag() {
    return openTags.get(this);
  }

  get closeTag() {
    return closeTags.get(this);
  }

  get(path) {
    const m = actuals.get(this);
    const { s } = m;
    const rootPropertyName = rootPropertyNames.get(this);

    let pathSegments = path.split('/').reverse();

    let pathSegment = pathSegments.pop();

    let node = this;

    if (pathSegment === '..') {
      pathSegment = rootPropertyName;
    } else {
      if (pathSegment === '.') {
        pathSegment = pathSegments.pop();
      }

      for (const tag of node.children) {
        if (tag.type === ReferenceTag && tag.value.name === rootPropertyName) {
          node = s.nodeForPath(s.pathForTag(tag));
        }
      }
    }

    while (pathSegment) {
      for (const tag of node.children) {
        if (tag.type === ReferenceTag && tag.value.name === pathSegment) {
          node = s.nodeForPath(s.pathForTag(tag));
        }
      }
      pathSegment = pathSegments.pop();
    }

    return node;
  }

  has(path) {
    throw new Error('not implemented');
  }
}

Object.seal(MatchFragmentFacade);

export class Match extends WeakStackFrame {
  constructor(
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

    super();

    this.context = context;
    this.language = language;
    this.languageRelativePath = languageRelativePath;
    this.state = state;
    this.matcher = matcher;
    this.declaredPath = declaredPath;
    this.effects = effects;
    this.co = co;

    this.path = state.path;
    this.leftSkewedRange = [];
  }

  static from(context, language, state) {
    return Match.create(context, language, state);
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

  get openTag() {
    const previousTag = this.leftSkewedRange?.[0];

    return previousTag && this.ctx.agast.getNextTag(previousTag);
  }

  get closeTag() {
    return this.leftSkewedRange?.[1];
  }

  get range() {
    const { openTag, closeTag } = this;
    return this.leftSkewedRange === null ? null : [openTag, closeTag];
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

  exec(state, effects, matcher, value, intrinsicValue) {
    let { ctx, languageRelativePath, declaredPath } = this;
    const { grammars, productionEnhancer } = ctx;
    const { type } = matcher;

    const language = resolveLanguage(ctx, this.language, matcher.language);
    const grammar = grammars.get(language);
    const isNode = grammar.covers?.get(nodeTopType).has(type);

    if (!language) {
      throw new Error(`Unknown language ${matcher.language}`);
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
          Object.entries(matcher.attributes || {}).map(([k, v]) => buildAttribute(k, v)),
        ),
      ),
      intrinsicValue,
    });

    const co = new Coroutine(enhancedProduction.call(grammar, props));

    if (!co.generator) {
      throw new Error('Production was not a generator');
    }

    languageRelativePath =
      isNode || isString(matcher.language)
        ? emptyStack
        : matcher.language
        ? languageRelativePath.push(matcher.language)
        : languageRelativePath;

    const match = this.push(
      ctx,
      language,
      state,
      matcher,
      effects,
      co,
      languageRelativePath,
      isNode ? undefined : declaredPath,
    );

    return match;
  }
}
