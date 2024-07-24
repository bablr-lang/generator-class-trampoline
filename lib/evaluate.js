import isString from 'iter-tools-es/methods/is-string';
import {
  effectsFor,
  shouldBranch,
  reifyExpression,
  buildGap,
  buildShift,
  buildString,
  buildNull,
  buildCall,
  buildArray,
  buildLiteral,
  buildReference,
  buildDoctypeTag,
  buildNodeOpenTag,
  buildNodeCloseTag,
  buildObject,
} from '@bablr/agast-vm-helpers';
import { resolveLanguage } from '@bablr/helpers/grammar';
import { printPath, parsePath } from '@bablr/agast-helpers/path';
import { StreamGenerator } from '@bablr/agast-helpers/stream';
import { Match } from './match.js';
import { getCooked } from '@bablr/agast-helpers/tree';

const { hasOwn } = Object;

const nodeTopType = Symbol.for('@bablr/node');
const defer = Symbol('defer');

function buildTag(tag) {
  switch (tag.type) {
    case 'Literal':
      return buildLiteral(buildString(tag.value));
    case 'Gap':
      return buildGap();
    default:
      throw new Error();
  }
}

export const createParseStrategy = (ctx, rootLanguage, rootMatcher, rootProps) => {
  return (s, agastCtx) => {
    if (agastCtx !== ctx.agast) throw new Error();

    return new StreamGenerator(parseStrategy(ctx, rootLanguage, rootMatcher, rootProps, s));
  };
};

function* parseStrategy(ctx, rootLanguage, rootMatcher, rootValue, s) {
  let m = Match.from(ctx, ctx.languages.get(rootLanguage), s);
  let matchReturnValue = undefined;
  let processingReturn = false;
  let alreadyAdvanced = false;

  m.leftSkewedRange[0] = s.result;

  yield buildCall('advance', buildDoctypeTag({ 'bablr-language': rootLanguage }));

  yield buildCall('advance', buildNodeOpenTag());

  m = m.exec(s, effectsFor('eat'), { type: null }, rootValue);

  m.leftSkewedRange[0] = s.result;

  while (m.co) {
    if (!m.co.done && !alreadyAdvanced) {
      m.co.advance(matchReturnValue);
    }

    alreadyAdvanced = false;
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

      if (m.zombie && verb !== 'write') {
        throw new Error(`zombie production cannot act on {verb: ${verb}}`);
      }

      if (!m.zombie && s.status === 'rejected') {
        break;
      }

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
          let sourceMatcher = sourceInstr.properties.arguments.properties.values[0];
          let start;

          // Do something better here pls
          const isRegexPattern =
            matcher &&
            matcher.type === 'Pattern' &&
            matcher.language === 'https://bablr.org/languages/core/en/bablr-regex-pattern';

          if (isHold) {
            if (!m.co.done) throw new Error('hold instructions must be returned from productions');

            if (!matcher || !matcher.type || isRegexPattern) {
              throw new Error('hold needs a node matcher');
            }
          }

          if (m.type === null && matcher?.type === null) {
            matcher = reifyExpression(rootMatcher);

            if (!path) throw new Error('document root matcher must have a path');
          }

          if (matcher?.type === null) {
            if (!s.path.depth) {
              matcher = { ...matcher, type: getCooked(rootMatcher.properties.type) };
            } else {
              throw new Error();
            }
          }

          if (matcher === null) {
            if (path && effects.success === 'eat') {
              const { name, isArray } = parsePath(path);

              if (!s.node.resolver.counters.has(name)) {
                yield buildCall('advance', buildReference(name, isArray));
                start = yield buildCall('advance', sourceMatcher);
              }
            } else {
              start = buildNull();
            }

            returnValue = start;
            break;
          } else if ((matcher.type || matcher.type === null) && !isRegexPattern) {
            let { flags, language: tagLanguage, intrinsicValue, type, attributes } = matcher;

            const previous = s.result;

            const selfClosing = intrinsicValue && flags.token;

            const resolvedLanguage = resolveLanguage(m.language, tagLanguage);

            if (tagLanguage && !resolvedLanguage) {
              throw new Error(`Unresolvable language ${tagLanguage}`);
            }

            const grammar = ctx.grammars.get(resolvedLanguage);
            const isNode = grammar.covers?.get(nodeTopType).has(type);
            const isCover = grammar.covers?.has(type);
            const atGap = s.source.atGap && !flags.trivia;
            const shouldInterpolate = atGap && (isNode || isCover) && !flags.intrinsic;

            if (flags.token && !isNode) {
              throw new Error('tokens must be nodes');
            }

            let intrinsicResult;

            if (intrinsicValue && !shouldInterpolate) {
              intrinsicResult = yield buildCall('match', sourceMatcher);

              if (
                (!intrinsicResult && effects.failure === 'fail') ||
                (intrinsicResult && effects.success === 'fail')
              ) {
                s = yield buildCall('reject');

                break instrLoop;
              } else if (!intrinsicResult) {
                if (isNode || isCover) {
                  const resolvedPath = path || m.declaredPath;

                  if (!resolvedPath) {
                    throw new Error(`language failed to specify a path for node of type ${type}`);
                  }

                  const { name, isArray } = parsePath(resolvedPath);

                  // this is copy pasta
                  if (s.node && !s.node.resolver.counters.has(name)) {
                    if (!s.node.flags.trivia && !s.node.flags.escape) {
                      yield buildCall('advance', buildReference(name, isArray));
                    }

                    yield buildCall('advance', buildNull());
                  }
                }

                returnValue = null;
                break;
              }
            }

            if (shouldBranch(effects) && !shouldInterpolate && !intrinsicValue) {
              s = yield buildCall('branch');
            }

            let shift = null;

            if (isHold) {
              shift = yield buildCall('advance', buildShift());
            }

            // advance reference?
            if (
              !isHold &&
              (isNode || isCover) &&
              s.result?.type !== 'Reference' &&
              s.path &&
              !flags.trivia &&
              !flags.escape &&
              effects.success === 'eat'
            ) {
              const strPath =
                isNode || isCover
                  ? !path || path.type === 'Null'
                    ? m.declaredPath || printPath(s.path.reference?.value)
                    : reifyExpression(path)
                  : null;
              const { name, isArray } = parsePath(strPath);

              yield buildCall('advance', buildReference(name, isArray));
            }

            // advance gap or start tag
            if (shouldInterpolate) {
              start = yield buildCall('advance', buildGap());
            } else if (isNode && !isCover) {
              const langPath = [
                ...(tagLanguage
                  ? m.languageRelativePath.push(tagLanguage)
                  : m.languageRelativePath
                ).values(),
              ];

              const unboundAttributes = hasOwn(grammar, 'attributes')
                ? grammar.attributes.get(type) || []
                : [];

              const options = buildObject({
                unboundAttributes: buildArray(unboundAttributes.map((attr) => buildString(attr))),
              });

              start = yield buildCall(
                'advance',
                buildNodeOpenTag(
                  flags,
                  langPath,
                  type,
                  intrinsicValue && flags.intrinsic
                    ? ctx.agast.sourceTextFor(intrinsicResult)
                    : undefined,
                  attributes,
                ),
                ...(unboundAttributes.length ? [options] : []),
              );
            }

            // how should we continue?
            if (selfClosing) {
              let end = start;
              if (!start.value.intrinsicValue) {
                for (const terminal of ctx.agast.allTerminalsFor(intrinsicResult)) {
                  if (terminal.type === 'Literal') {
                    yield buildCall('advance', buildLiteral(buildString(terminal.value)));
                  } else {
                    throw new Error();
                  }
                }

                end = yield buildCall('advance', buildNodeCloseTag(type, matcher.language));
              }
              returnValue = [start, end];
            } else if (!shouldInterpolate) {
              const sourceProps = sourceInstr.properties.arguments.properties.values[2];

              if (m.co.done) {
                m = m.parent; // replace the current stack frame -- tail call optimization
              }

              m = m.exec(s, effects, matcher, sourceProps, intrinsicResult);

              if (m.leftSkewedRange[0]) throw new Error();

              m.leftSkewedRange[0] = shift || previous;

              if (path && !isNode) {
                if (m.declaredPath) {
                  throw new Error('double-specified path');
                }

                m.declaredPath = path;
              }

              m.co.advance();

              returnValue = defer;
            } else {
              returnValue = [start, start];
            }
          } else if (isString(matcher) || isRegexPattern) {
            let range = yield buildCall(
              'match',
              sourceInstr.properties.arguments.properties.values[0],
            );

            if ((!range && effects.failure === 'fail') || (range && effects.success === 'fail')) {
              s = yield buildCall('reject');
              break instrLoop;
            }

            if (range && effects.success === 'eat') {
              let start, end;
              for (let token of ctx.agast.ownTerminalsFor(range)) {
                token = yield buildCall('advance', buildTag(token));
                start = start || token;
                end = token || end;
              }
              if (start) {
                range = [start, end];
              }
            }

            returnValue = range;
            break;
          } else {
            throw new Error();
          }
          break;
        }

        case 'fail': {
          s = yield buildCall('reject');
          break instrLoop;
        }

        case 'write':
          yield sourceInstr;
          break;

        case 'bindAttribute': {
          yield sourceInstr;
          break;
        }

        default: {
          throw new Error(`Unknown instruction {type: ${verb}}`);
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
      const { type, flags, grammar, matcher, startTag, effects, captured } = m;
      const isNode = grammar.covers.get(nodeTopType).has(type);
      const isCover = grammar.covers.has(type);
      const allowEmpty = !!grammar.emptyables?.has(type);

      const throwing = m.s !== s || (m.empty && !allowEmpty);

      let { range } = m;

      if (!m.zombie) {
        if (!throwing) {
          if (isNode && !isCover && !captured) {
            yield buildCall('advance', buildNodeCloseTag(type, startTag.value.language));
          }
        }

        if (!m.leftSkewedRange[0] || m.leftSkewedRange[1]) throw new Error();

        if (throwing) {
          m.leftSkewedRange = null;
        } else {
          m.leftSkewedRange[1] = s.result;
        }

        m.co.finalize();

        ({ range } = m);

        if (shouldBranch(effects) && !matcher.intrinsicValue) {
          // we branched, so we must clean up the branch

          if (m.s.status === 'rejected') {
            ({ s } = m.parent);
          } else if (m.s.status !== 'active') {
            throw new Error();
          } else if (
            (range && effects.success === 'fail') ||
            (!range && effects.failure === 'fail')
          ) {
            s = yield buildCall('reject');
          } else {
            s = yield buildCall('accept');
          }
        } else {
          if ((range && effects.success === 'fail') || (!range && effects.failure === 'fail')) {
            if (m.s === s) {
              s = yield buildCall('reject');
            }
          }
        }

        if (!m.co.done) {
          // Zombie
          alreadyAdvanced = true;
          continue;
        } else if (m.co.value) {
          // there is a return value to process
          processingReturn = true;
          continue;
        }
      } else {
        if (!m.co.done) throw new Error();
      }

      m = m.parent;

      if (m.co) {
        matchReturnValue = range;
        continue;
      } else {
        if (!throwing && range) {
          yield buildCall('advance', buildNodeCloseTag());
          m.leftSkewedRange[1] = s.result;

          if (!m.state.source.done) {
            throw new Error(
              `parse ate ${m.state.source.index} characters but the input was not consumed`,
            );
          }

          return m.range;
        } else {
          throw new Error(`parse failed after ${m.state.source.index} characters`);
        }
      }
    }
  }
}
