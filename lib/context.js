import { buildDependentLanguages } from '@bablr/helpers/grammar';
import { facades, actuals } from './facades.js';

export const ContextFacade = class BABLRContextFacade {
  get languages() {
    return actuals.get(this).languages;
  }

  get grammars() {
    return actuals.get(this).grammars;
  }

  get productionEnhancer() {
    return actuals.get(this).productionEnhancer;
  }

  get agast() {
    return actuals.get(this).agast;
  }

  getPreviousTerminal(token) {
    return actuals.get(this).agast.getPreviousTerminal(token);
  }

  allTerminalsFor(range) {
    return actuals.get(this).agast.allTerminalsFor(range);
  }

  getCooked(node) {
    return actuals.get(this).agast.getCooked(node);
  }

  reifyExpression(value) {
    return actuals.get(this).agast.reifyExpression(value);
  }

  sourceTextFor(node) {
    return actuals.get(this).agast.sourceTextFor(node);
  }

  unbox(value) {
    return actuals.get(this).agast.unbox(value);
  }
};

export const Context = class BABLRContext {
  static from(agastContext, language, productionEnhancer) {
    return new Context(agastContext, buildDependentLanguages(language), productionEnhancer);
  }

  constructor(agastContext, languages, productionEnhancer) {
    this.agast = agastContext;
    this.languages = languages;
    this.productionEnhancer = productionEnhancer;

    this.grammars = new WeakMap();
    this.facade = new ContextFacade();

    for (const { 1: language } of this.languages) {
      this.grammars.set(language, new language.grammar());
    }

    facades.set(this, this.facade);
  }
};
