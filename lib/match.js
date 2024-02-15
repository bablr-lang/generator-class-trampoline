import { Coroutine } from '@bablr/coroutine';
import { getCooked } from '@bablr/agast-helpers/tree';
import { getProduction } from '@bablr/class-grammar-helpers';
import { WeakStackFrame } from '@bablr/weak-stack';
import { grammars } from './utils/facades.js';

export class Match extends WeakStackFrame {
  constructor(context, state, matcher, effects, co) {
    if (!context || !state || (matcher && (!effects || !co))) {
      throw new Error('Invalid arguments to Match constructor');
    }

    super();

    this.context = context;
    this.state = state;
    this.matcher = matcher;
    this.effects = effects;
    this.co = co;

    this.path = state.path;
    this.range = [];
  }

  static from(context, state) {
    return Match.create(context, state, null, null, null);
  }

  get ctx() {
    return this.context;
  }

  get s() {
    return this.state;
  }

  get type() {
    return getCooked(this.matcher.properties.type);
  }

  get grammar() {
    return grammars.get(this.context);
  }

  get captured() {
    return !!this.range[1];
  }

  get empty() {
    const { range, ctx, path, parent } = this;

    if (range[0]?.type === 'OpenNodeTag' && path !== parent.path) {
      const nextTag = ctx.nextTerminals.get(range[0]);
      if (!nextTag || nextTag.type === 'CloseNodeTag') {
        return null;
      }
    } else {
      return range[0] === range[1];
    }
  }

  exec(state, effects, matcher, props) {
    if (typeof path === 'string') throw new Error();

    const { ctx, grammar } = this;
    const type = getCooked(matcher.properties.type);

    const co = new Coroutine(
      // type may be Language:Type
      getProduction(grammar, type).apply(grammar, [props, state, ctx]),
    );

    const match = this.push(ctx, state, matcher, effects, co);

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
