import { getCooked } from '@bablr/agast-helpers/stream';
import { facades, actuals } from './facades.js';

const languages = new WeakMap();
const grammars = new WeakMap();

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
