import { getCooked } from '@bablr/agast-helpers/stream';

const { freeze } = Object;

const _facades = new WeakMap();

export const facades = {
  get(actual) {
    return actual == null ? actual : _facades.get(actual);
  },

  set(actual, facade) {
    if (_facades.has(actual) || _actuals.has(facade) || actual === facade) {
      throw new Error('facade mappings must be 1:1');
    }

    freeze(facade);

    _facades.set(actual, facade);
    _actuals.set(facade, actual);
  },
};

const _actuals = new WeakMap();

export const actuals = {
  get(facade) {
    return facade == null ? facade : _actuals.get(facade);
  },
};

export const languages = new WeakMap();
export const grammars = new WeakMap();
export const contexts = new WeakMap();

export class ContextFacade {
  static from(actual, language) {
    return new ContextFacade(actual, language);
  }

  constructor(actual, language) {
    facades.set(actual, this);
    languages.set(this, language);
    grammars.set(this, new language.grammar());
  }

  getInnerText(range) {
    return actuals.get(this).getInnerText(range);
  }

  getPreviousTerminal(token) {
    return actuals.get(this).getPreviousTerminal(token);
  }

  ownTerminalsFor(range) {
    return actuals.get(this).ownTerminalsFor(range);
  }

  allTerminalsFor(range) {
    return actuals.get(this).allTerminalsFor(range);
  }

  getCooked(range) {
    return getCooked(this.ownTerminalsFor(range));
  }

  unbox(value) {
    return actuals.get(this).unbox(value);
  }
}

export class StateFacade {
  constructor(actual, context) {
    facades.set(actual, this);
    contexts.set(this, context);
  }

  static from(actual, context) {
    return new StateFacade(actual, context);
  }

  get span() {
    return actuals.get(this).span;
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

  get ctx() {
    return this.context;
  }
}
