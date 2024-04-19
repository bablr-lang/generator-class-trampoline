import equal from 'iter-tools-es/methods/equal';
import emptyStack from '@iter-tools/imm-stack';
import { Coroutine } from '@bablr/coroutine';
import { getProduction, resolveLanguage } from '@bablr/helpers/grammar';
import { WeakStackFrame } from '@bablr/weak-stack';

const nodeTopType = Symbol.for('@bablr/node');

export class Match extends WeakStackFrame {
  constructor(
    context,
    language,
    state,
    matcher,
    productionEnhancer,
    effects,
    co,
    languageRelativePath,
  ) {
    if (!context || !language || !state || (!matcher && (!effects || !co))) {
      throw new Error('Invalid arguments to Match constructor');
    }

    super();

    this.context = context;
    this.language = language;
    this.languageRelativePath = languageRelativePath;
    this.state = state;
    this.matcher = matcher;
    this.productionEnhancer = productionEnhancer;
    this.effects = effects;
    this.co = co;

    this.path = state.path;
    this.range = [];
  }

  static from(context, language, state, matcher, productionEnhancer) {
    return Match.create(
      context,
      language,
      state,
      matcher,
      productionEnhancer,
      null,
      null,
      emptyStack,
    );
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
    return this.matcher.type;
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

  exec(state, effects, matcher, props) {
    if (typeof path === 'string') throw new Error();

    const { ctx, productionEnhancer, languageRelativePath } = this;
    const { grammars } = ctx;
    const { type } = matcher;

    const language = resolveLanguage(this.language, matcher.language);
    const grammar = grammars.get(language);
    const isNode = grammar.covers.get(nodeTopType).has(type);

    if (!language) {
      throw new Error(`Unknown language ${matcher.language}`);
    }

    const production = getProduction(grammar, type);

    if (!production) throw new Error('Unknown production');

    const enhancedProduction = productionEnhancer(production, type);

    const co = new Coroutine(enhancedProduction.apply(grammar, [props, state, ctx]));

    if (!co.generator) {
      throw new Error('Production was not a generator');
    }

    const match = this.push(
      ctx,
      language,
      state,
      matcher,
      productionEnhancer,
      effects,
      co,
      isNode ? emptyStack : languageRelativePath,
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
