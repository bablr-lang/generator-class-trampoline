import {
  effectsFor,
  shouldBranch,
  reifyExpression,
  reifyAttributes,
  buildCall,
} from '@bablr/vm-helpers';
import { getCooked, printPath } from '@bablr/ast-helpers';
import { Match } from './match.js';

const nodeTopType = Symbol.for('@bablr/node');

const defer = Symbol('defer');

export function* createParseTrampoline(rootMatcher, rootProps) {
  let s = yield buildCall('getState');
  let { ctx } = s;
  let m = Match.from(ctx, s, rootProps);
  let matchReturnValue = undefined;

  yield buildCall(
    'startNode',
    null,
    // this is wrong: we bind matcher attributes now
    rootMatcher.properties.attributes && reifyExpression(rootMatcher.properties.attributes),
  );

  m.range[0] = s.result;

  m = m.exec(s, effectsFor('eat'), rootMatcher, rootProps);

  while (m.co) {
    m.co.advance(matchReturnValue);

    matchReturnValue = undefined;

    instrLoop: while (!m.co.done) {
      const instr = m.co.value;

      let returnValue = undefined;

      const { verb: verbToken, verbSuffix: verbSuffixToken, arguments: args } = instr.properties;
      const verb = getCooked(verbToken);
      const verbSuffix = verbSuffixToken && getCooked(verbSuffixToken);

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

          if (['NodeMatcher', 'TerminalMatcher'].includes(matcher.type)) {
            if (!s.path.reference) {
              const type = getCooked(rootMatcher.properties.type);
              const isNode = m.grammar.covers.get(nodeTopType).has(type);
              const isCover = m.grammar.covers.has(type);

              if (isNode && !isCover) {
                yield buildCall('reference', 'root');
                yield buildCall('startNode', type, rootMatcher.attributes);
              }
            }

            const type = getCooked(matcher.properties.type);
            const isNode = m.grammar.covers.get(nodeTopType).has(type);
            const isTerminalNode = matcher.type === 'TerminalMatcher';
            const isCover = m.grammar.covers.has(type);
            const strPath =
              isNode || isCover
                ? !path || path.type === 'Null'
                  ? printPath(m.path.reference?.value) || 'root'
                  : getCooked(path.properties.content)
                : null;

            const attributes = reifyAttributes(matcher.properties.attributes);

            if (verbSuffix) {
              throw new Error('Nodes cannot be trivia or escapes');
            }

            if (shouldBranch(effects)) {
              s = yield buildCall('branch');
            }

            if (
              (isNode || isCover) &&
              s.result.type !== 'ReferenceTag' &&
              effects.success === 'eat'
            ) {
              yield buildCall('reference', strPath);
            }

            if (isNode && !isCover) {
              start = yield buildCall('startNode', type, attributes, isTerminalNode);
            }

            m = m.exec(s, effects, matcher, props);

            m.co.advance();

            returnValue = defer;
          } else {
            start = returnValue = yield instr;

            if (!returnValue && effects.failure === 'fail') {
              s = yield buildCall('reject');
              break instrLoop;
            }
          }

          if (!m.range[0] && start) {
            let m_ = m;
            while (!m_.range[0]) {
              m_.range[0] = start;
              m_ = m.parent;
            }
          }

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
        yield buildCall('endNode', type);
      }

      const range = failed ? null : m.capture();

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
          yield buildCall('endNode', null);
          const range = m.capture();
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
