import isString from 'iter-tools-es/methods/is-string';
import {
  effectsFor,
  shouldBranch,
  reifyExpression,
  reifyExpressionShallow,
  buildCall,
  buildObject,
  buildLiteral,
  buildReference,
  buildNodeOpenTag,
  buildNodeCloseTag,
  buildFragmentOpenTag,
  buildFragmentCloseTag,
  buildExpression as expr,
} from '@bablr/agast-vm-helpers';
import { printPath, parsePath } from '@bablr/agast-helpers/path';
import { buildGap } from '@bablr/agast-helpers/builders';
import { Match } from './match.js';
import { StateFacade } from './state.js';

const { hasOwn } = Object;

const unbound = Symbol.for('@bablr/unbound');
const nodeTopType = Symbol.for('@bablr/node');
const defer = Symbol('defer');

function* parseStrategy(rootMatcher, rootProps, rootState, ctx) {
  let s = StateFacade.from(rootState, ctx);
  let m = Match.from(ctx, s, rootProps);
  let matchReturnValue = undefined;

  yield buildCall('advance', buildFragmentOpenTag());

  m.range[0] = s.result;

  m = m.exec(s, effectsFor('eat'), reifyExpression(rootMatcher), rootProps);

  while (m.co) {
    m.co.advance(matchReturnValue);

    matchReturnValue = undefined;

    instrLoop: while (!m.co.done) {
      const sourceInstr = m.co.value;
      const instr = reifyExpression(sourceInstr);
      const { verb, arguments: args } = instr;

      let returnValue = undefined;

      switch (verb) {
        case 'eat':
        case 'eatMatch':
        case 'match':
        case 'guard': {
          const { 0: matcher, 1: path, 2: props } = args;

          const effects = effectsFor(verb);

          let start;

          // Do something better here pls
          const isRegexPattern = matcher.type === 'Pattern' && matcher.language === 'Regex';

          if (matcher === null) {
            if (effects.success === 'eat') {
              start = yield buildCall('advance', matcher);
            } else {
              start = buildGap();
            }

            returnValue = start;
            break;
          } else if (matcher.type && !isRegexPattern) {
            if (!s.path.reference) {
              // can this move somewhere else?
              const { type } = reifyExpression(rootMatcher);
              const isNode = ctx.grammar.covers.get(nodeTopType).has(type);
              const isCover = ctx.grammar.covers.has(type);

              if (isNode && !isCover) {
                yield buildCall('advance', buildReference('root', false));
                yield buildCall('advance', rootMatcher);
              }
            }

            const { flags, type, attributes } = matcher;
            const isNode = ctx.grammar.covers.get(nodeTopType).has(type);
            const isCover = ctx.grammar.covers.has(type);
            const strPath =
              isNode || isCover
                ? !path || path.type === 'Null'
                  ? printPath(m.path.reference?.value) || 'root'
                  : reifyExpression(path)
                : null;

            const unboundAttributes = hasOwn(ctx.grammar, 'unboundAttributes')
              ? ctx.grammar.unboundAttributes.get(type) || []
              : [];

            const attributes_ = {
              ...attributes,
              ...Object.fromEntries(unboundAttributes.map((attr) => [attr, unbound])),
            };

            if (shouldBranch(effects)) {
              s = yield buildCall('branch');
            }

            // const { resolver } = s.path;

            if (
              (isNode || isCover) &&
              // (!(pathIsArray && resolver.counters.has(pathName)) || !shouldBranch(effects)) &&
              s.result?.type !== 'Reference' // &&
              // effects.success === 'eat'
            ) {
              const { pathName, pathIsArray } = parsePath(strPath);

              yield buildCall('advance', buildReference(pathName, pathIsArray));
            }

            if (isNode && !isCover) {
              start = yield buildCall('advance', buildNodeOpenTag(flags, type, attributes_));
            }

            let props_ = sourceInstr.properties.arguments.properties.values[2];

            if (flags.token) {
              props_ = buildObject({
                ...reifyExpressionShallow(props_),
                value: matcher.children[0].value,
              });
            }

            m = m.exec(s, effects, matcher, props_);

            m.co.advance();

            returnValue = defer;
          } else if (isString(matcher) || isRegexPattern) {
            const result = yield buildCall(
              'match',
              sourceInstr.properties.arguments.properties.values[0],
            );

            if (!result && effects.failure === 'fail') {
              s = yield buildCall('reject');
              break instrLoop;
            }

            start = result && expr(result);

            if (result && effects.success === 'eat') {
              yield buildCall('advance', buildLiteral(result));
            }

            returnValue = start;
            break;
          } else {
            throw new Error();
          }

          m.startCapture(start);

          break;
        }

        case 'fail': {
          s = yield buildCall('reject');
          break instrLoop;
        }

        case 'bindAttribute': {
          const start = yield sourceInstr;

          if (m.path === m.parent.path) {
            throw new Error('Only @Node productions can bind attributes');
          }

          m.range[0] = start;
          break;
        }

        default: {
          throw new Error('Unknown instruction type');
        }
      }

      if (returnValue === defer) {
        // execution is suspeneded until the state stack unwinds
      } else if (!m.co.done) {
        m.co.advance(returnValue);
      }
    } // end instrLoop

    {
      // resume suspended execution
      const { type } = m;
      const failed = m.s !== s;
      const { effects } = m;

      if (
        !failed &&
        ctx.grammar.covers.get(nodeTopType).has(type) &&
        !ctx.grammar.covers.has(type) &&
        m.s.result.type !== 'OpenNodeTag'
      ) {
        yield buildCall('advance', buildNodeCloseTag(type));
      }

      const range = failed ? null : m.endCapture();

      const completedMatch = m;

      m = m.collect();

      if (!failed && completedMatch.s !== m.s) {
        if ((range && effects.success === 'fail') || !range) {
          s = yield buildCall('reject');
        } else {
          s = yield buildCall('accept');
        }
      }

      if (m.co) {
        ({ s } = m);
        matchReturnValue = range;
      } else {
        if (!failed) {
          yield buildCall('advance', buildFragmentCloseTag());
          const range = m.endCapture();
          if (range) {
            return range;
          } else {
            throw new Error('parsing failed');
          }
        } else {
          throw new Error('parsing failed');
        }
      }
    }
  }
}

export const createParseStrategy = (rootMatcher, rootProps) => {
  return (...args) => parseStrategy(rootMatcher, rootProps, ...args);
};
