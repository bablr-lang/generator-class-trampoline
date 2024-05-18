import equal from 'iter-tools-es/methods/equal';
import emptyStack from '@iter-tools/imm-stack';
import { Coroutine } from '@bablr/coroutine';
import { getProduction, resolveLanguage } from '@bablr/helpers/grammar';
import { WeakStackFrame } from '@bablr/weak-stack';
import { getCooked } from '@bablr/agast-helpers/stream';
import { buildString, buildAttribute, buildCall, buildGap } from '@bablr/agast-vm-helpers';

const nodeTopType = Symbol.for('@bablr/node');
const { freeze } = Object;

function* defaultFragment() {
  yield buildCall('eat', buildGap());
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
    this.range = [];
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
    return this.matcher?.type || Symbol.for('@bablr/fragment');
  }

  get captured() {
    return !!this.range[1];
  }

  get startTag() {
    return this.range[0];
  }

  get endTag() {
    return this.range[1];
  }

  get empty() {
    const { range, ctx } = this;

    return equal('', ctx.sourceTextFor(range));
  }

  get isNode() {
    const { grammar, type } = this;
    return grammar.covers.get(nodeTopType).has(type);
  }

  get isCover() {
    const { grammar, type } = this;
    return grammar.covers.has(type);
  }

  exec(state, effects, matcher, value) {
    let { ctx, languageRelativePath, declaredPath } = this;
    const { grammars, productionEnhancer } = ctx;
    const { type, flags } = matcher;

    const language = resolveLanguage(this.language, matcher.language);
    const grammar = grammars.get(language);
    const isNode = grammar.covers.get(nodeTopType).has(type);

    if (!language) {
      throw new Error(`Unknown language ${matcher.language}`);
    }

    let production = getProduction(grammar, type);

    if (!production) {
      if (type === Symbol.for('@bablr/fragment')) {
        production = defaultFragment;
      } else {
        throw new Error(`Unknown production {type: ${type}}`);
      }
    }

    const enhancedProduction = productionEnhancer
      ? productionEnhancer(production, type)
      : production;

    const intrinsicValue = flags?.intrinsic ? buildString(getCooked(matcher.children)) : null;

    const props = freeze({
      value,
      state,
      s: state,
      context: ctx,
      ctx,
      attributes: Object.entries(matcher.attributes || {}).map(([k, v]) => buildAttribute(k, v)),
      intrinsicValue,
    });

    const co = new Coroutine(enhancedProduction.call(grammar, props));

    if (!co.generator) {
      throw new Error('Production was not a generator');
    }

    languageRelativePath = isNode
      ? undefined
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

    match.range[0] = state.result;

    return match;
  }

  startCapture() {
    const { range, state } = this;
    const start = state.result;

    if (!range[0] && start) {
      let m_ = this;
      while (!m_.range[0]) {
        m_.range[0] = start;
        m_ = m_.parent;
      }
    }

    return range;
  }

  endCapture() {
    const { range, state, grammar, type } = this;
    const end = state.result;
    const allowEmpty = !!grammar.emptyables?.has(type);

    if (!range[0]) {
      throw new Error();
    }

    range[1] = end;

    return this.empty && !allowEmpty ? null : range;
  }

  collect() {
    let { captured, empty, co, parent, state, grammar, type } = this;
    const allowEmpty = !!grammar.emptyables?.has(type);

    co.finalize();

    if (co.value) return this;

    if (!parent) return null;

    if (!captured || (empty && !allowEmpty)) {
      while (parent.co && parent.state === state) {
        parent.co.finalize();
        ({ parent } = parent);
      }
    }

    return parent;
  }
}
