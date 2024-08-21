import isString from 'iter-tools-es/methods/is-string';
import { effectsFor, shouldBranch, reifyExpression } from '@bablr/agast-vm-helpers';
import {
  buildEmbeddedExpression,
  buildEmbeddedNode,
  buildEmbeddedTag,
} from '@bablr/agast-vm-helpers/internal-builders';
import { embedExpression } from '@bablr/agast-vm-helpers/embed';
import {
  buildCall,
  buildGap,
  buildShift,
  buildNull,
  buildLiteral,
  buildReference,
  buildDoctypeTag,
  buildNodeOpenTag,
  buildNodeCloseTag,
} from '@bablr/agast-helpers/builders';
import { resolveLanguage, unresolveLanguage } from '@bablr/helpers/grammar';
import { printPath, parsePath } from '@bablr/agast-helpers/path';
import { StreamGenerator } from '@bablr/agast-helpers/stream';
import { getCooked } from '@bablr/agast-helpers/tree';
import { Match } from './match.js';

const { hasOwn } = Object;

const nodeTopType = Symbol.for('@bablr/node');
const defer = Symbol('defer');

function buildTag(tag) {
  switch (tag.type) {
    case 'LiteralTag':
      return buildLiteral(tag.value);
    case 'Gap':
      return buildGap();
    default:
      throw new Error();
  }
}

export const createParseStrategy = (ctx, rootMatcher, rootProps) => {
  return (s, agastCtx) => {
    if (agastCtx !== ctx.agast.facade) throw new Error();

    return new StreamGenerator(parseStrategy(ctx, rootMatcher, rootProps, s));
  };
};

function* parseStrategy(ctx, rootMatcher, rootValue, s) {
  let m = Match.from(
    ctx,
    ctx.languages.get(getCooked(rootMatcher.properties.language.properties.content)),
    s,
  );
  let matchReturnValue = undefined;
  let processingReturn = false;
  let alreadyAdvanced = false;

  m.leftSkewedRange[0] = s.result;

  yield buildCall(
    'advance',
    buildEmbeddedTag(buildDoctypeTag({ 'bablr-language': m.language.canonicalURL })),
  );

  yield buildCall('advance', buildEmbeddedTag(buildNodeOpenTag({}, m.language.canonicalURL)));

  m = m.exec(
    s,
    effectsFor('eat'),
    { flags: {}, language: m.language.canonicalURL, type: null },
    rootValue,
  );

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

              if (!hasOwn(s.node.properties, name)) {
                yield buildCall('advance', buildEmbeddedTag(buildReference(name, isArray)));
                start = yield buildCall('advance', buildEmbeddedTag(buildNull()));
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

            const resolvedLanguage = resolveLanguage(ctx, m.language, tagLanguage);

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
              intrinsicResult = yield buildCall('match', buildEmbeddedNode(sourceMatcher));

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
                  if (
                    s.node &&
                    !hasOwn(s.node.properties, name) &&
                    !(s.result.type === 'Reference' && s.result.value.name === name)
                  ) {
                    if (!s.node.flags.trivia && !s.node.flags.escape) {
                      yield buildCall('advance', buildEmbeddedTag(buildReference(name, isArray)));
                    }

                    yield buildCall('advance', buildEmbeddedTag(buildNull()));
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
              shift = yield buildCall('advance', buildEmbeddedTag(buildShift()));
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

              yield buildCall('advance', buildEmbeddedTag(buildReference(name, isArray)));
            }

            // advance gap or start tag
            if (shouldInterpolate) {
              start = yield buildCall('advance', buildEmbeddedTag(buildGap()));
            } else if (isNode && !isCover) {
              const absoluteLanguage = resolveLanguage(ctx, m.language, tagLanguage).canonicalURL;

              // unresolveLanguage(ctx, m.language, resolvedLanguage.canonicalURL);

              const unboundAttributes = hasOwn(grammar, 'attributes')
                ? grammar.attributes.get(type) || []
                : [];

              const options = buildEmbeddedExpression({ unboundAttributes });

              start = yield buildCall(
                'advance',
                buildEmbeddedTag(
                  buildNodeOpenTag(
                    flags,
                    absoluteLanguage,
                    type,
                    // intrinsicValue && flags.intrinsic
                    //   ? ctx.agast.sourceTextFor(intrinsicResult)
                    //   : undefined,
                    attributes,
                  ),
                ),
                ...(unboundAttributes.length ? [options] : []),
              );
            }

            // how should we continue?
            if (selfClosing) {
              for (const Tag of ctx.agast.allTagsFor(intrinsicResult)) {
                if (Tag.type === 'LiteralTag') {
                  yield buildCall('advance', buildEmbeddedTag(buildLiteral(Tag.value)));
                } else {
                  throw new Error();
                }
              }

              yield buildCall(
                'advance',
                buildEmbeddedTag(buildNodeCloseTag(type, matcher.language)),
              );

              returnValue = s.nodeForTag(start);
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
              returnValue = s.nodeForTag(start);
            }
          } else if (isString(matcher) || isRegexPattern) {
            const pattern = sourceInstr.properties.arguments.properties.values[0];
            let range = yield buildCall('match', buildEmbeddedNode(pattern));

            if ((!range && effects.failure === 'fail') || (range && effects.success === 'fail')) {
              s = yield buildCall('reject');
              break instrLoop;
            }

            if (range && effects.success === 'eat') {
              let start, end;
              for (let token of ctx.agast.allTagsFor(range)) {
                token = yield buildCall('advance', buildEmbeddedTag(buildTag(token)));
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
          const { 0: text, 1: options } = args;
          yield buildCall('write', text, embedExpression(options));
          break;

        case 'bindAttribute': {
          const { 0: key, 1: value } = args;
          yield buildCall('bindAttribute', key, embedExpression(value));
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
      const { type, grammar, matcher, startTag, effects, captured } = m;
      const isNode = grammar.covers.get(nodeTopType).has(type);
      const isCover = grammar.covers.has(type);
      const allowEmpty = !!grammar.emptyables?.has(type);

      const throwing = m.s !== s || (m.empty && !allowEmpty);

      let { range } = m;

      if (!m.zombie) {
        if (!throwing) {
          if (isNode && !isCover && !captured) {
            yield buildCall(
              'advance',
              buildEmbeddedTag(buildNodeCloseTag(type, startTag.value.language)),
            );
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

      if (m.s !== s) {
        m.co.finalize();
      }

      if (m.co) {
        matchReturnValue = range && s.nodeForTag(range[1]);
        continue;
      } else {
        if (!throwing && range) {
          yield buildCall('advance', buildEmbeddedTag(buildNodeCloseTag()));
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
