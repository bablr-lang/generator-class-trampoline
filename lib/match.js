import { Coroutine } from '@bablr/coroutine';
import { getProduction } from '@bablr/helpers/grammar';
import { WeakStackFrame } from '@bablr/weak-stack';

export class Match extends WeakStackFrame {
  constructor(context, language, state, matcher, effects, co) {
    if (!context || !language || !state || (matcher && (!effects || !co))) {
      throw new Error('Invalid arguments to Match constructor');
    }

    super();

    this.context = context;
    this.language = language;
    this.state = state;
    this.matcher = matcher;
    this.effects = effects;
    this.co = co;

    this.path = state.path;
    this.range = [];
  }

  static from(context, language, state) {
    return Match.create(context, language, state, null, null, null);
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

  get empty() {
    const { range, ctx, path, parent } = this;

    if (range[0]?.type === 'OpenNodeTag' && path !== parent.path) {
      const nextTag = ctx.agast.getNextTerminal(range[0]);
      if (!nextTag || nextTag.type === 'CloseNodeTag') {
        return null;
      }
    } else {
      return range[0] === range[1];
    }
  }

  resolveLanguage(language) {
    const currentLanguage = this.language;

    return language
      ? language.startsWith('https://')
        ? language
        : currentLanguage.dependencies[language].canonicalURL
      : currentLanguage.canonicalURL;
  }

  exec(state, effects, matcher, props) {
    if (typeof path === 'string') throw new Error();

    const { ctx } = this;
    const { languages, grammars } = ctx;
    const { type } = matcher;

    const url = this.resolveLanguage(matcher.language);

    const language = languages.get(url);
    const grammar = grammars.get(language);

    if (!language) {
      throw new Error(`Unknown language ${url}`);
    }

    const co = new Coroutine(
      // type may be Language:Type
      getProduction(grammar, type).apply(grammar, [props, state, ctx]),
    );

    const match = this.push(ctx, language, state, matcher, effects, co);

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
    const { range, state } = this;
    const end = state.result;

    if (!range[0] || (range[0].type === 'OpenNodeTag' && end === range[0])) return null;

    range[1] = end;

    return this.empty ? null : range;
  }

  collect() {
    let { captured, empty, co, parent, state } = this;

    co.finalize();

    if (!parent) return null;

    if (!captured || empty) {
      while (parent.co && parent.state === state) {
        parent.co.finalize();
        ({ parent } = parent);
      }
    }

    return parent;
  }
}
