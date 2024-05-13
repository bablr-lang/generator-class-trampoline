import isString from 'iter-tools-es/methods/is-string';
import {
  effectsFor,
  shouldBranch,
  reifyExpression,
  buildGap,
  buildNull,
  buildCall,
  buildLiteral,
  buildReference,
  buildDoctypeTag,
  buildNodeOpenTag,
  buildNodeCloseTag,
  buildFragmentOpenTag,
  buildFragmentCloseTag,
} from '@bablr/agast-vm-helpers';
import { resolveLanguage } from '@bablr/helpers/grammar';
import { printPath, parsePath } from '@bablr/agast-helpers/path';
import { StreamGenerator } from '@bablr/agast-helpers/stream';
import { Match } from './match.js';

const { hasOwn } = Object;

const nodeTopType = Symbol.for('@bablr/node');
const fragmentType = Symbol.for('@bablr/fragment');
const defer = Symbol('defer');

function* parseStrategy(rootLanguage, rootMatcher, rootProps, s, ctx) {
  let m = Match.from(ctx, ctx.languages.get(rootLanguage), s);
  let matchReturnValue = undefined;
  let processingReturn = false;

  yield buildCall('advance', buildDoctypeTag({ 'bablr-language': rootLanguage }));

  yield buildCall('advance', buildFragmentOpenTag());

  m.range[0] = s.result;

  m = m.exec(s, effectsFor('eat'), { type: fragmentType });

  coLoop: while (m.co) {
    if (!m.co.done) {
      m.co.advance(matchReturnValue);
    }

    matchReturnValue = undefined;

    instrLoop: for (;;) {
      if (m.co.current instanceof Promise) {
        m.co.current = yield m.co.current;
      }

      if (m.co.done && !processingReturn) break;

      processingReturn = false;

      const sourceInstr = m.co.value;
      const instr = reifyExpression(sourceInstr);
      const { verb, arguments: args } = instr;

      let returnValue = undefined;

      switch (verb) {
        case 'eat':
        case 'eatMatch':
        case 'match':
        case 'guard':
        case 'holdFor':
        case 'holdForMatch': {
          const effects = effectsFor(verb);
          const isHold = verb === 'holdFor' || verb === 'holdForMatch';
          let { 0: matcher, 1: path, 2: props } = args;
          let start;

          // Do something better here pls
          const isRegexPattern =
            matcher &&
            matcher.type === 'Pattern' &&
            matcher.language === 'https://bablr.org/languages/offical/regex-vm-pattern';

          if (isHold) {
            if (!m.co.done) throw new Error('hold instructions must be returned from productions');

            if (!matcher || !matcher.type || isRegexPattern) {
              throw new Error('hold needs a node matcher');
            }
          }

          if (m.type === fragmentType && matcher?.type === 'Gap') {
            matcher = reifyExpression(rootMatcher);
          }

          if (matcher === null) {
            if (path && effects.success === 'eat') {
              const { name, isArray } = parsePath(path);

              yield buildCall('advance', buildReference(name, isArray));
              start = yield buildCall(
                'advance',
                sourceInstr.properties.arguments.properties.values[0],
              );
            } else {
              start = buildNull();
            }

            returnValue = start;
            break;
          } else if (matcher.type === 'Gap') {
            throw new Error('not implemented');
          } else if (matcher.type && !isRegexPattern) {
            const { flags, language: tagLanguage, type, intrinsicValue, attributes } = matcher;

            let intrinsicResult;

            if (flags.intrinsic) {
              intrinsicResult = yield buildCall(
                'match',
                sourceInstr.properties.arguments.properties.values[0],
              );

              if (
                (!intrinsicResult && effects.failure === 'fail') ||
                (intrinsicResult && effects.success === 'fail')
              ) {
                s = yield buildCall('reject');
                break instrLoop;
              } else if (!intrinsicResult) {
                returnValue = null;
                break;
              }
            }

            const resolvedLanguage = resolveLanguage(m.language, tagLanguage);

            if (tagLanguage && !resolvedLanguage) {
              throw new Error('Unresolvable language');
            }

            const grammar = ctx.grammars.get(resolvedLanguage);
            const isNode = grammar.covers.get(nodeTopType).has(type);
            const isCover = grammar.covers.has(type);
            const atGap = s.source.atGap && !flags.trivia;

            if (shouldBranch(effects) && !flags.intrinsic) {
              s = yield buildCall('branch');
            }

            if (isHold) {
              yield buildCall('shift');
            }

            // advance reference?
            if (
              !isHold &&
              (isNode || isCover) &&
              s.result?.type !== 'Reference' &&
              s.result?.type !== 'OpenFragmentTag' &&
              !flags.trivia &&
              !flags.escape &&
              effects.success === 'eat'
            ) {
              if (path && m.declaredPath) throw new Error();

              if (s.path.depth > 0) {
                const strPath =
                  isNode || isCover
                    ? !path || path.type === 'Null'
                      ? m.declaredPath || printPath(s.path.reference?.value)
                      : reifyExpression(path)
                    : null;
                const { name, isArray } = parsePath(strPath);

                yield buildCall('advance', buildReference(name, isArray));
              }
            }

            // advance gap or start tag
            if (atGap && (isNode || isCover)) {
              if (s.holding) {
                yield buildCall('unshift');
              } else {
                start = yield buildCall('advance', buildGap());
              }
            } else if (isNode && !isCover) {
              const path = [
                ...(tagLanguage
                  ? m.languageRelativePath.push(tagLanguage)
                  : m.languageRelativePath
                ).values(),
              ];

              const unboundAttributes = hasOwn(grammar, 'attributes')
                ? grammar.attributes.get(type) || []
                : [];

              const attributes_ = {
                ...attributes,
                ...Object.fromEntries(unboundAttributes.map((attr) => [attr, buildGap()])),
              };

              start = yield buildCall(
                'advance',
                buildNodeOpenTag(flags, path, type, reifyExpression(intrinsicResult), attributes_),
              );
            }

            // how should we continue?
            if (!atGap && !flags.intrinsic) {
              const sourceProps = sourceInstr.properties.arguments.properties.values[2];

              if (m.co.done) {
                m = m.parent; // replace the current stack frame -- tail call optimization
              }

              m = m.exec(s, effects, matcher, sourceProps);

              if (!isNode && tagLanguage) {
                m.languageRelativePath = m.languageRelativePath.push(tagLanguage);
              }

              if (path && !isNode && !isCover) {
                if (m.declaredPath) {
                  throw new Error('double-specified path');
                }

                m.declaredPath = path;
              }

              m.co.advance();

              returnValue = defer;
            } else {
              returnValue = start;
            }
          } else if (isString(matcher) || isRegexPattern) {
            const result = yield buildCall(
              'match',
              sourceInstr.properties.arguments.properties.values[0],
            );

            if ((!result && effects.failure === 'fail') || (result && effects.success === 'fail')) {
              s = yield buildCall('reject');
              break instrLoop;
            }

            if (result) {
              start = buildLiteral(result);

              if (effects.success === 'eat' && !s.node.flags.intrinsic) {
                start = yield buildCall('advance', start);
              }
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
      const { type, grammar, startTag, effects } = m;
      const failed = m.s !== s;
      const isNode = grammar.covers.get(nodeTopType).has(type);
      const isCover = grammar.covers.has(type);
      const completedMatch = m;

      if (!failed && isNode && !isCover) {
        yield buildCall('advance', buildNodeCloseTag(type, startTag.value.language));
      }

      const range = failed ? null : m.endCapture();

      m = m.collect();
      ({ s } = m);

      if (m === completedMatch) {
        // there is a return value to process
        processingReturn = true;
        continue coLoop;
      }

      if (!failed && completedMatch.s !== s) {
        if ((range && effects.success === 'fail') || !range) {
          s = yield buildCall('reject');
        } else {
          s = yield buildCall('accept');
        }
      }

      if (m.co) {
        matchReturnValue = range;
      } else {
        if (!failed && range) {
          yield buildCall('advance', buildFragmentCloseTag());
          const range = m.endCapture();

          if (!m.state.source.done) {
            throw new Error('parse failed to consume input');
          }

          return range;
        } else {
          throw new Error('parsing failed');
        }
      }
    }
  }
}

export const createParseStrategy = (rootLanguage, rootMatcher, rootProps) => {
  return (...args) =>
    new StreamGenerator(parseStrategy(rootLanguage, rootMatcher, rootProps, ...args));
};
