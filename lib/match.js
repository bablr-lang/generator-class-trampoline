import equal from 'iter-tools-es/methods/equal';
import isString from 'iter-tools-es/methods/is-string';
import emptyStack from '@iter-tools/imm-stack';
import { Coroutine } from '@bablr/coroutine';
import { getProduction, resolveLanguage } from '@bablr/helpers/grammar';
import { sourceTextFor } from '@bablr/agast-helpers/stream';
import { WeakStackFrame } from '@bablr/weak-stack';
import { buildAttribute, buildCall, buildSpamMatcher, buildString } from '@bablr/agast-vm-helpers';
import { GapTag } from '@bablr/agast-helpers/symbols';
import { facades } from './facades.js';

const nodeTopType = Symbol.for('@bablr/node');
const { freeze } = Object;

function* defaultFragment() {
  yield buildCall('eat', buildSpamMatcher(), buildString('root'));
}

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

  get startTag() {
    const previousTag = this.leftSkewedRange?.[0];

    return previousTag && this.ctx.agast.getNextTag(previousTag);
  }

  get endTag() {
    return this.leftSkewedRange?.[1];
  }

  get range() {
    const { startTag, endTag } = this;
    return this.leftSkewedRange === null ? null : [startTag, endTag];
  }

  get empty() {
    const { range, ctx } = this;

    if (range?.[0]?.type === GapTag) return false;

    return equal('', sourceTextFor(ctx.agast.allTagsFor(range)));
  }

  get isNode() {
    const { grammar, type } = this;
    return grammar.covers.get(nodeTopType).has(type);
  }

  get isCover() {
    const { grammar, type } = this;
    return grammar.covers.has(type);
  }

  exec(state, effects, matcher, value, intrinsicValue) {
    let { ctx, languageRelativePath, declaredPath } = this;
    const { grammars, productionEnhancer } = ctx;
    const { type } = matcher;

    const contextFacade = facades.get(ctx);

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
      context: contextFacade,
      ctx: contextFacade,
      attributes: Object.entries(matcher.attributes || {}).map(([k, v]) => buildAttribute(k, v)),
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
