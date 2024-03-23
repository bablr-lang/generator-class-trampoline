import { facades, actuals } from './facades.js';

const contexts = new WeakMap();

export class StateFacade {
  constructor(actual, context) {
    facades.set(actual, this);
    contexts.set(this, context);
  }

  static from(actual, context) {
    return new StateFacade(actual, context);
  }

  get result() {
    return actuals.get(this).result;
  }

  get context() {
    return contexts.get(this);
  }

  get path() {
    return actuals.get(this).path;
  }

  get depth() {
    return actuals.get(this).depth;
  }

  get span() {
    return actuals.get(this).span;
  }

  get ctx() {
    return this.context;
  }
}
