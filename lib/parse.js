import {
  effectsFor,
  shouldBranch,
  reifyExpression,
  reifyAttributes,
  buildCall,
  buildAttributes,
  buildExpression as expr,
} from '@bablr/agast-vm-helpers';
import { printPath } from '@bablr/agast-helpers/path';
import { buildLiteral, buildGap } from '@bablr/agast-helpers/builders';
import { Match } from './match.js';
import { ContextFacade, StateFacade } from './facades.js';

const { hasOwn } = Object;

const unbound = Symbol.for('@bablr/unbound');
const nodeTopType = Symbol.for('@bablr/node');
const defer = Symbol('defer');

function* parseStrategy(language, rootMatcher, rootProps, rootState, rootContext) {
  let ctx = ContextFacade.from(rootContext, language);
  let s = StateFacade.from(rootState, ctx);
  let m = Match.from(ctx, s, rootProps);
  let matchReturnValue = undefined;

  yield buildCall('startNode', expr(null), expr(null));

  m.range[0] = s.result;

  m = m.exec(s, effectsFor('eat'), rootMatcher, rootProps);

  while (m.co) {
    m.co.advance(matchReturnValue);

    matchReturnValue = undefined;

    instrLoop: while (!m.co.done) {
      const instr = m.co.value;

      let returnValue = undefined;

      const { verb: verbToken, arguments: args } = instr.properties;
      const verb = reifyExpression(verbToken);

      switch (verb) {
        case 'eat':
        case 'eatMatch':
        case 'match':
        case 'guard': {
          const {
            properties: { values: { 0: matcher, 1: path, 2: props } = [] },
          } = args;

          const effects = effectsFor(verb);

          let start;

          switch (matcher.type) {
            case 'NodeMatcher': {
              if (!s.path.reference) {
                // can this move somewhere else?
                const { properties } = rootMatcher;
                const { flags, type, attributes } = properties;
                const cookedType = reifyExpression(type);
                const isNode = m.grammar.covers.get(nodeTopType).has(cookedType);
                const isCover = m.grammar.covers.has(cookedType);

                if (isNode && !isCover) {
                  yield buildCall('reference', expr('root'));
                  yield buildCall('startNode', flags, type, attributes);
                }
              }

              const { properties } = matcher;
              const type = reifyExpression(properties.type);
              const isNode = m.grammar.covers.get(nodeTopType).has(type);
              const isCover = m.grammar.covers.has(type);
              const strPath =
                isNode || isCover
                  ? !path || path.type === 'Null'
                    ? printPath(m.path.reference?.value) || 'root'
                    : reifyExpression(path)
                  : null;

              const unboundAttributes = hasOwn(m.grammar, 'unboundAttributes')
                ? m.grammar.unboundAttributes.get(type) || []
                : [];

              const attributes_ = {
                ...reifyAttributes(matcher.properties.attributes),
                ...Object.fromEntries(unboundAttributes.map((attr) => [attr, unbound])),
              };

              if (shouldBranch(effects)) {
                s = yield buildCall('branch');
              }

              // const { pathName, pathIsArray } = parsePath(strPath);
              // const { resolver } = s.path;

              if (
                (isNode || isCover) &&
                // (!(pathIsArray && resolver.counters.has(pathName)) || !shouldBranch(effects)) &&
                s.result.type !== 'Reference' // &&
                // effects.success === 'eat'
              ) {
                yield buildCall('reference', expr(strPath));
              }

              if (isNode && !isCover) {
                start = yield buildCall(
                  'startNode',
                  properties.flags,
                  properties.type,
                  buildAttributes(attributes_),
                );
              }

              m = m.exec(s, effects, matcher, props);

              m.co.advance();

              returnValue = defer;
              break;
            }

            case 'Null': {
              if (effects.success === 'eat') {
                start = yield buildCall('advance', matcher);
              } else {
                start = buildGap();
              }

              returnValue = start;
              break;
            }

            case 'String':
            case 'Pattern': {
              const result = yield buildCall('match', matcher);

              if (!result && effects.failure === 'fail') {
                s = yield buildCall('reject');
                break instrLoop;
              }

              if (result && effects.success === 'eat') {
                start = yield buildCall('advance', expr(result));
              } else if (returnValue) {
                start = buildLiteral(result);
              }

              returnValue = start;
              break;
            }

            default: {
              throw new Error();
            }
          }

          m.startCapture(start);

          break;
        }

        case 'fail': {
          s = yield buildCall('reject');
          break instrLoop;
        }

        case 'bindAttribute': {
          const start = yield instr;

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
        m.grammar.covers.get(nodeTopType).has(type) &&
        !m.grammar.covers.has(type) &&
        m.s.result.type !== 'OpenNodeTag'
      ) {
        yield buildCall('endNode', expr(type));
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
          yield buildCall('endNode', expr(null));
          const range = m.endCapture();
          if (range) {
            if (!s.source.done) {
              throw new Error('Parser failed to consume input');
            }
            if (s.balanced.size) {
              throw new Error('Parser did not match all balanced nodes');
            }

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

export const createParseStrategy = (language, rootMatcher, rootProps) => {
  return (...args) => parseStrategy(language, rootMatcher, rootProps, ...args);
};
