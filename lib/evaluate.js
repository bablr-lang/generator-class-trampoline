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
  buildGapTag,
  buildShiftTag,
  buildNullTag,
  buildReferenceTag,
  buildDoctypeTag,
  buildNodeOpenTag,
  buildNodeCloseTag,
  buildArrayTag,
  buildFragmentOpenTag,
  buildFragmentCloseTag,
} from '@bablr/agast-helpers/builders';
import { resolveLanguage, unresolveLanguage } from '@bablr/helpers/grammar';
import { printPath, parsePath } from '@bablr/agast-helpers/path';
import { StreamGenerator } from '@bablr/agast-helpers/stream';
import { getCooked, getRoot, isNull } from '@bablr/agast-helpers/tree';
import * as btree from '@bablr/agast-helpers/btree';
import { Match, MatchFragmentFacade } from './match.js';
import { ReferenceTag, OpenFragmentTag, CloseFragmentTag } from '@bablr/agast-helpers/symbols';
import { isEmpty } from 'iter-tools-es';

const { hasOwn } = Object;

const nodeTopType = Symbol.for('@bablr/node');
const defer = Symbol('defer');

export const createParseStrategy = (rootMatcher, rootProps) => {
  return (s, ctx) => {
    return new StreamGenerator(parseStrategy(ctx, rootMatcher, rootProps, s));
  };
};

function* parseStrategy(ctx, rootMatcher, rootValue, s) {
  const gapsAllowed = !isNull(rootMatcher.properties.open.properties.flags.properties.hasGapToken);
  let m = Match.from(
    ctx,
    ctx.languages.get(
      getCooked(getRoot(rootMatcher).properties.open.properties.language.properties.content),
    ),
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

  yield buildCall(
    'advance',
    buildEmbeddedTag(buildFragmentOpenTag({ hasGap: gapsAllowed }, m.language.canonicalURL)),
  );

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
          let sourceMatcher = btree.getAt(
            0,
            getRoot(sourceInstr).properties.arguments.properties.values,
          );
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

            if (path) throw new Error('invalid root fragment path');
          }

          if (matcher?.type === null) {
            if (!s.path.depth) {
              matcher = { ...matcher, type: getCooked(rootMatcher.properties.type) };
            } else {
              throw new Error();
            }
          }

          const parsedPath = path && parsePath(path);
          const parsedResolvedPath =
            !parsedPath || parsedPath.isRoot
              ? m.declaredPath || parsedPath || parsePath('.')
              : parsedPath;

          if (
            sourceMatcher?.type === 'Array' &&
            sourceMatcher.language === 'https://bablr.org/languages/core/en/bablr-vm-instruction'
          ) {
            const { name, isArray, hasGap } = parsedResolvedPath;

            if (!isArray && name !== '.') throw new Error();

            if (!s.node.has(name)) {
              yield buildCall(
                'advance',
                buildEmbeddedTag(buildReferenceTag(name, true, gapsAllowed && hasGap)),
              );
              start = yield buildCall('advance', buildEmbeddedTag(buildArrayTag()));
            }

            returnValue = start;
          } else if (matcher === null) {
            if (parsedResolvedPath && effects.success === 'eat') {
              const { name, isArray, hasGap } = parsedResolvedPath;

              if (!s.node.has(name)) {
                yield buildCall(
                  'advance',
                  buildEmbeddedTag(buildReferenceTag(name, isArray, gapsAllowed && hasGap)),
                );
                start = yield buildCall('advance', buildEmbeddedTag(buildNullTag()));
              }
            } else {
              start = buildNullTag();
            }

            returnValue = start;
            break;
          } else if ((matcher.type || matcher.type === null) && !isRegexPattern) {
            let { flags, language: tagLanguage, intrinsicValue, type, attributes } = matcher;

            const previous = s.result;

            const selfClosing = intrinsicValue && flags.token;

            // const resolvedLanguage = resolveLanguage(ctx, m.language, tagLanguage);
            const language = resolveLanguage(ctx, m.language, tagLanguage);
            const absoluteLanguage = language.canonicalURL;

            if (tagLanguage && !language) {
              throw new Error(`Unresolvable language ${tagLanguage}`);
            }

            const grammar = ctx.grammars.get(language);
            const isNode = grammar.covers?.get(nodeTopType).has(type);
            const isCover = grammar.covers?.has(type);
            const atGap = s.source.atGap && !flags.trivia;
            const shouldInterpolate = atGap && (isNode || isCover) && parsedPath?.hasGap;

            if (flags.token && !isNode) {
              const language = resolveLanguage(ctx, m.language, tagLanguage);
              const absoluteLanguage = language.canonicalURL;
              throw new Error('tokens must be nodes');
            }

            let intrinsicResult;

            if (intrinsicValue && !shouldInterpolate) {
              intrinsicResult = yield buildCall('match', buildEmbeddedNode(sourceMatcher));

              if (
                (!intrinsicResult && effects.failure === 'fail') ||
                (intrinsicResult && effects.success === 'fail')
              ) {
                const language = resolveLanguage(ctx, m.language, tagLanguage);
                const absoluteLanguage = language.canonicalURL;
                s = yield buildCall('reject');

                break instrLoop;
              } else if (!intrinsicResult) {
                if (isNode || isCover) {
                  if (!parsedResolvedPath) {
                    throw new Error(`language failed to specify a path for node of type ${type}`);
                  }

                  const { name, isArray, hasGap } = parsedResolvedPath;

                  // this is copy pasta
                  if (
                    s.node &&
                    !s.node.has(name) &&
                    !(s.result.type === ReferenceTag && s.result.value.name === name)
                  ) {
                    if (!s.node.flags.trivia && !s.node.flags.escape) {
                      yield buildCall(
                        'advance',
                        buildEmbeddedTag(buildReferenceTag(name, isArray, gapsAllowed && hasGap)),
                      );

                      yield buildCall(
                        'advance',
                        buildEmbeddedTag(isArray ? buildArrayTag() : buildNullTag()),
                      );
                    }
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
              shift = yield buildCall('advance', buildEmbeddedTag(buildShiftTag()));
            }

            // advance reference?
            if (
              !isHold &&
              (isNode || isCover) &&
              s.result?.type !== ReferenceTag &&
              s.path &&
              !flags.trivia &&
              !flags.escape &&
              effects.success === 'eat'
            ) {
              let innerParsedResolvedPath =
                isNode || isCover
                  ? parsedResolvedPath ||
                    m.declaredPath ||
                    (s.path.depth ? printPath(s.path.reference?.value) : parsePath('.'))
                  : null;

              const { name, isArray, hasGap } = innerParsedResolvedPath;

              if (isArray && !s.node.has(name)) {
                yield buildCall(
                  'advance',
                  buildEmbeddedTag(buildReferenceTag(name, true, gapsAllowed && hasGap)),
                );
                yield buildCall('advance', buildEmbeddedTag(buildArrayTag()));
              }

              yield buildCall(
                'advance',
                buildEmbeddedTag(buildReferenceTag(name, isArray, gapsAllowed && hasGap)),
              );
            }

            // advance gap or start tag
            if (shouldInterpolate) {
              // need to advance many gap tags if embedded is an array
              // intersperse them with separators

              start = yield buildCall('advance', buildEmbeddedTag(buildGapTag()));
            } else if (isNode && !isCover) {
              const language = resolveLanguage(ctx, m.language, tagLanguage);
              const absoluteLanguage = language.canonicalURL;

              // unresolveLanguage(ctx, m.language, resolvedLanguage.canonicalURL);

              const unboundAttributes = hasOwn(grammar, 'unboundAttributes')
                ? grammar.unboundAttributes.get(type) || []
                : [];

              if (flags.escape) {
                unboundAttributes.push('cooked');
              }

              const staticAttributes = hasOwn(grammar, 'attributes')
                ? grammar.attributes.get(type) || {}
                : {};

              const options = buildEmbeddedExpression({ unboundAttributes });
              start = yield buildCall(
                'advance',
                buildEmbeddedTag(
                  buildNodeOpenTag(
                    {
                      ...flags,
                      hasGap: flags.escape
                        ? false
                        : flags.hasGap || (flags.token ? false : gapsAllowed),
                    },
                    absoluteLanguage,
                    Symbol.for(type),
                    // intrinsicValue && flags.intrinsic
                    //   ? ctx.agast.sourceTextFor(intrinsicResult)
                    //   : undefined,
                    { ...staticAttributes, ...attributes },
                  ),
                ),
                ...(unboundAttributes.length ? [options] : []),
              );
            }

            // how should we continue?
            if (selfClosing) {
              for (const tag of intrinsicResult.children) {
                if (tag.type === OpenFragmentTag || tag.type === CloseFragmentTag) continue;
                yield buildCall('advance', buildEmbeddedTag(tag));
              }

              yield buildCall(
                'advance',
                buildEmbeddedTag(buildNodeCloseTag(Symbol.for(type), matcher.language)),
              );

              returnValue = s.nodeForTag(start);
            } else if (!shouldInterpolate) {
              const sourceProps = btree.getAt(
                2,
                getRoot(sourceInstr).properties.arguments.properties.values,
              );

              if (m.co.done) {
                m = m.parent; // replace the current stack frame -- tail call optimization
              }

              m = m.exec(s, effects, matcher, sourceProps, intrinsicResult);

              if (m.leftSkewedRange[0]) throw new Error();

              m.leftSkewedRange[0] = shift || previous;

              if (path && !isNode) {
                if (m.declaredPath && !parsedPath.isRoot) {
                  throw new Error('double-specified path');
                }

                if (m.declaredPath && m.declaredPath.isArray && !parsedPath.isArray) {
                  throw new Error('inconsistent use of []');
                }

                m.declaredPath = parsedPath;
              }

              m.co.advance();

              returnValue = defer;
            } else {
              returnValue = s.nodeForTag(start);
            }
          } else if (isString(matcher) || isRegexPattern) {
            const pattern = btree.getAt(
              0,
              getRoot(sourceInstr).properties.arguments.properties.values,
            );
            let result = yield buildCall('match', buildEmbeddedNode(pattern));

            if ((!result && effects.failure === 'fail') || (result && effects.success === 'fail')) {
              s = yield buildCall('reject');
              break instrLoop;
            }

            if (result && effects.success === 'eat') {
              for (let tag of result.children) {
                if (tag.type === OpenFragmentTag || tag.type === CloseFragmentTag) continue;
                yield buildCall('advance', buildEmbeddedTag(tag));
              }
            }

            returnValue = result;
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

        case 'write': {
          const { 0: text, 1: options } = args;
          yield buildCall('write', text, embedExpression(options));
          break;
        }

        case 'openSpan':
        case 'closeSpan': {
          const { 0: name } = args;
          yield buildCall(verb, name);
          break;
        }

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
      const finishedMatch = m;
      // resume suspended execution
      const { type, grammar, matcher, openTag, effects, captured } = m;
      const isNode = grammar.covers?.get(nodeTopType).has(type);
      const isCover = grammar.covers?.has(type);
      const allowEmpty = !!grammar.emptyables?.has(type);

      const isEmpty_ = !m.range || isEmpty(ctx.agast.allTagsFor([m.range[0], s.result]));
      const wasRejected = m.s !== s;

      const throwing = wasRejected || (isEmpty_ && !allowEmpty);

      let { range } = m;

      if (!m.zombie) {
        if (!throwing) {
          if (isNode && !isCover && !captured) {
            yield buildCall(
              'advance',
              buildEmbeddedTag(buildNodeCloseTag(Symbol.for(type), openTag.value.language)),
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
            isEmpty_ ||
            (allowEmpty && effects.success === 'fail') ||
            (!isEmpty_ && !allowEmpty && effects.failure === 'fail')
          ) {
            s = yield buildCall('reject');
          } else {
            s = yield buildCall('accept');
          }
        } else {
          if (
            ((!isEmpty_ || allowEmpty) && effects.success === 'fail') ||
            (isEmpty_ && !allowEmpty && effects.failure === 'fail')
          ) {
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

        if (!m.co.done) {
          // Zombie
          alreadyAdvanced = true;
          continue;
        } else if (m.co.value) {
          // there is a return value to process
          processingReturn = true;
          continue;
        }
      }

      if (m.co) {
        matchReturnValue = throwing ? null : new MatchFragmentFacade(finishedMatch);
        continue;
      } else {
        if (!throwing && range) {
          yield buildCall('advance', buildEmbeddedTag(buildFragmentCloseTag()));
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
