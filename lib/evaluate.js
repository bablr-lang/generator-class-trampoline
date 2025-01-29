import isString from 'iter-tools-es/methods/is-string';
import { effectsFor, reifyExpression, shouldBranch } from '@bablr/agast-vm-helpers';
import {
  buildEmbeddedObject,
  buildEmbeddedNode,
  buildEmbeddedTag,
  buildArrayInitializerTag,
  buildFragmentCloseTag,
  buildDoctypeTag,
  referenceFlags,
  buildFragmentOpenTag,
  nodeFlags,
  getFlagsWithGap,
  buildGapTag,
  buildShiftTag,
  buildNullTag,
  buildReferenceTag,
  buildOpenNodeTag,
  buildCloseNodeTag,
} from '@bablr/agast-vm-helpers/internal-builders';
import { embedExpression } from '@bablr/agast-vm-helpers/embed';
import {
  buildPattern,
  buildAlternatives,
  buildRegexGap,
  buildNodeFlags,
  buildBasicNodeMatcher,
  buildFragmentMatcher,
  buildPropertyMatcher,
  buildReferenceMatcher,
  buildReferenceFlags,
} from '@bablr/helpers/builders';
import { resolveLanguage, unresolveLanguage } from '@bablr/helpers/grammar';
import { isEmpty, StreamGenerator } from '@bablr/agast-helpers/stream';
import { buildCall, getCooked, getRoot, isNull, mergeReferences } from '@bablr/agast-helpers/tree';
import * as btree from '@bablr/agast-helpers/btree';
import {
  ReferenceTag,
  OpenFragmentTag,
  CloseFragmentTag,
  CloseNodeTag,
  NullTag,
  GapTag,
} from '@bablr/agast-helpers/symbols';
import * as sym from '@bablr/agast-helpers/symbols';
import { allTagsFor, TagPath } from '@bablr/agast-helpers/path';
import { buildCoroutine, coroutines } from './match.js';

const { freeze, hasOwn } = Object;

const nodeTopType = Symbol.for('@bablr/node');
const defer = Symbol('defer');

export const createParseStrategy = (rootMatcher, rootProps) => {
  return (s, ctx) => {
    return new StreamGenerator(parseStrategy(ctx, rootMatcher, rootProps, s));
  };
};

const fragmentMatcher = buildPropertyMatcher(null, buildBasicNodeMatcher(buildFragmentMatcher()));

function* parseStrategy(ctx, rootMatcher, rootValue, s) {
  const gapsAllowed = !isNull(
    getRoot(rootMatcher).properties.nodeMatcher.node.properties.open.node.properties.flags?.node
      .properties.hasGapToken,
  );

  let matchReturnValue = undefined;
  let processingReturn = false;
  let alreadyAdvanced = false;
  let zombie = false;
  let throwing = false;
  let m;

  {
    const matcher = reifyExpression(rootMatcher);
    const canonicalURL = matcher.nodeMatcher.open.language;

    yield buildCall('init', canonicalURL);

    m = yield buildCall(
      'startFrame',
      buildEmbeddedNode(fragmentMatcher),
      buildEmbeddedObject(effectsFor('eat')),
      buildEmbeddedObject(rootValue),
    );

    yield buildCall('advance', buildEmbeddedTag(buildDoctypeTag({ bablrLanguage: canonicalURL })));

    yield buildCall('advance', buildEmbeddedTag(buildFragmentOpenTag(getFlagsWithGap(nodeFlags))));
  }

  let co = buildCoroutine(ctx, s, m, {
    productionName: reifyExpression(rootMatcher).nodeMatcher.open.type,
  });

  while (co) {
    if (!co.done && !alreadyAdvanced && !throwing) {
      co.advance(matchReturnValue);
    }

    alreadyAdvanced = false;
    matchReturnValue = undefined;

    instrLoop: for (;;) {
      if (co.current instanceof Promise) {
        co.current = yield co.current;
      }

      if (co.done && !processingReturn) break;

      processingReturn = false;

      const sourceInstr = co.value;

      // if (sourceInstr.type !== null) throw new Error();

      const instr = reifyExpression(sourceInstr);
      const { verb, arguments: args } = instr;

      let returnValue = undefined;

      if (zombie && verb !== 'write') {
        throw new Error(`zombie production cannot act on {verb: ${verb}}`);
      }

      if (!zombie && s.status === 'rejected') {
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
          // eat(<Matcher>, 'path')
          // eat(path: <Matcher>)
          let { 0: matcher, 1: props, 2: options } = args;
          let { refMatcher } = matcher;
          let sourceMatcher = btree.getAt(
            0,
            getRoot(sourceInstr).properties.arguments.node.properties.values,
          ).node;
          let start;

          // Do something better here pls
          const isRegexPattern =
            matcher &&
            matcher.type === Symbol.for('Pattern') &&
            matcher.language === 'https://bablr.org/languages/core/en/bablr-regex-pattern';

          if (isHold) {
            if (!co.done) throw new Error('hold instructions must be returned from productions');

            if (!matcher || !matcher.nodeMatcher.open.type || isRegexPattern) {
              throw new Error('hold needs a node matcher');
            }
          }

          if (
            m.type === null &&
            sourceMatcher.type === Symbol.for('PropertyMatcher') &&
            sourceMatcher.properties.nodeMatcher.node.type === Symbol.for('BasicNodeMatcher') &&
            getCooked(
              sourceMatcher.properties.nodeMatcher.node.properties.open.node.properties.type.node,
            ) === '?'
          ) {
            matcher = reifyExpression(rootMatcher);
            sourceMatcher = rootMatcher;

            if (refMatcher) throw new Error('invalid root fragment path');
          }

          const parsedPath = refMatcher;
          const parsedResolvedPath =
            !parsedPath || parsedPath.name === '.'
              ? parsedPath || { name: '.', isArray: false, index: null, flags: referenceFlags }
              : parsedPath;

          if (!isRegexPattern && matcher.nodeMatcher?.type !== sym.gap && !isString(matcher)) {
            const { refMatcher, nodeMatcher } = matcher;
            const sourceNodeMatcher = getRoot(sourceMatcher).properties.nodeMatcher.node;

            if (sourceNodeMatcher.type === Symbol.for('ArrayNodeMatcher')) {
              const { name, isArray, flags } = parsedResolvedPath;

              if (!isArray && name !== '.') throw new Error();

              if (!s.node.has(name)) {
                let ownReference = buildReferenceTag(name, true, {
                  hasGap: gapsAllowed && flags.hasGap,
                });
                yield buildCall(
                  'advance',
                  buildEmbeddedTag(
                    m.isNode ? ownReference : mergeReferences(m.mergedReference, ownReference),
                  ),
                );
                start = yield buildCall('advance', buildEmbeddedTag(buildArrayInitializerTag()));
              }

              returnValue = start;
              break;
            } else if (sourceNodeMatcher.type === Symbol.for('NullNodeMatcher')) {
              if (parsedResolvedPath && effects.success === 'eat') {
                const { name, isArray, flags } = parsedResolvedPath;

                if (!s.node.has(name)) {
                  let ownReference = buildReferenceTag(name, isArray, {
                    hasGap: gapsAllowed && flags.hasGap,
                  });
                  yield buildCall(
                    'advance',
                    buildEmbeddedTag(
                      m.isNode ? ownReference : mergeReferences(m.mergedReference, ownReference),
                    ),
                  );
                  start = yield buildCall('advance', buildEmbeddedTag(buildNullTag()));
                }
              } else {
                start = buildNullTag();
              }

              returnValue = start;
              break;
            }

            let {
              flags,
              language: tagLanguage,
              intrinsicValue,
              type,
              attributes,
            } = nodeMatcher.open;

            const previousPath = s.resultPath;

            // const resolvedLanguage = resolveLanguage(ctx, m.language, tagLanguage);
            const language = resolveLanguage(ctx, m.language, tagLanguage);

            if (tagLanguage && !language) {
              throw new Error(`Unresolvable language ${tagLanguage}`);
            }

            const grammar = ctx.grammars.get(language);
            const isNode = grammar.covers?.get(nodeTopType).has(type) && !options?.suppressNode;
            const isCover = grammar.covers?.has(type);
            const atGap = (s.source.atGap && !flags.trivia) || isHold;
            const shouldInterpolate =
              atGap &&
              (isNode || isCover) &&
              parsedResolvedPath?.flags.hasGap &&
              !options?.suppressGap;

            if (isHold && !(isNode || isCover)) {
              throw new Error('hold must be returned from an @Node or @Cover production');
            }

            const selfClosing = !!(intrinsicValue && flags.token) || shouldInterpolate;

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
                throwing = true;

                break instrLoop;
              } else if (!intrinsicResult) {
                if ((isNode || isCover) && refMatcher && refMatcher.name !== '.') {
                  if (!parsedResolvedPath) {
                    throw new Error(`language failed to specify a path for node of type ${type}`);
                  }

                  const { name, isArray, flags: innerFlags } = parsedResolvedPath;

                  // this is copy pasta
                  if (
                    s.node &&
                    !s.node.has(name) &&
                    !(
                      s.resultPath.tag.type === ReferenceTag && s.resultPath.tag.value.name === name
                    )
                  ) {
                    if (name !== '#' && name !== '@') {
                      let ownReference = buildReferenceTag(name, isArray, {
                        hasGap: gapsAllowed && innerFlags.hasGap,
                      });
                      yield buildCall(
                        'advance',
                        buildEmbeddedTag(
                          m.isNode
                            ? ownReference
                            : mergeReferences(m.mergedReference, ownReference),
                        ),
                      );

                      yield buildCall(
                        'advance',
                        buildEmbeddedTag(isArray ? buildArrayInitializerTag() : buildNullTag()),
                      );
                    }
                  }
                }

                returnValue = null;
                break;
              }
            }

            let shift = null;

            if (isHold) {
              shift = yield buildCall('advance', buildEmbeddedTag(buildShiftTag()));
            }

            let ownReference = buildReferenceTag(
              parsedResolvedPath.name,
              parsedResolvedPath.isArray,
              parsedResolvedPath.flags,
            );
            let mergedReference = m.cover
              ? isNode
                ? m.cover.mergedReference
                : buildReferenceTag('.')
              : m.isNode || ['#', '@'].includes(ownReference.value.name)
              ? ownReference
              : mergeReferences(m.mergedReference, ownReference);

            if (isHold && !mergedReference.value.flags.expression) {
              throw new Error('Merged reference must have + for hold');
            }

            let refTags = [];

            // advance reference?
            if (!isHold && (isNode || isCover) && effects.success === 'eat' && !s.reference) {
              const { name, isArray, flags } = mergedReference.value;

              if (isArray && !s.node.has(name)) {
                refTags.push(buildReferenceTag(name, isArray, { ...flags, expression: false }));
                refTags.push(buildArrayInitializerTag());
              }

              refTags.push(mergedReference);
            }

            // advance gap or start tag
            if (shouldInterpolate) {
              // need to advance many gap tags if embedded is an array
              // intersperse them with separators

              start = buildGapTag();
            } else if (isNode && !isCover) {
              const language = resolveLanguage(ctx, m.language, tagLanguage);
              const absoluteLanguage = language.canonicalURL;

              // unresolveLanguage(ctx, m.language, resolvedLanguage.canonicalURL);

              const staticAttributes = hasOwn(grammar, 'attributes')
                ? grammar.attributes.get(type) || {}
                : {};

              start = buildOpenNodeTag(
                {
                  ...flags,
                  hasGap: flags.token
                    ? false
                    : !mergedReference
                    ? gapsAllowed
                    : mergedReference.value.name === '@'
                    ? false
                    : mergedReference.value.flags.hasGap || gapsAllowed,
                },
                absoluteLanguage,
                Symbol.for(type),
                // intrinsicValue && flags.intrinsic
                //   ? ctx.agast.sourceTextFor(intrinsicResult)
                //   : undefined,
                { ...staticAttributes, ...attributes },
              );
            }

            {
              if (matcher.nodeMatcher.open.type === '?') throw new Error();

              const unboundAttributes = hasOwn(grammar, 'unboundAttributes')
                ? grammar.unboundAttributes.get(type) || []
                : [];

              if (parsedResolvedPath.name === '@') {
                unboundAttributes.push('cooked');
              }
              const options = buildEmbeddedObject({ unboundAttributes });

              if (co.done) {
                yield buildCall('endFrame', true);

                m = m.parent;
              }

              m = yield buildCall(
                'startFrame',
                buildEmbeddedNode(
                  buildPropertyMatcher(
                    buildReferenceMatcher(
                      mergedReference.value.name,
                      mergedReference.value.isArray,
                      buildReferenceFlags(mergedReference.value.flags),
                    ),
                    sourceMatcher.properties.nodeMatcher.node,
                  ),
                ),
                buildEmbeddedObject(intrinsicValue ? effectsFor('eat') : effects),
                ...(unboundAttributes.length ? [options] : []),
              );
              s = m.state;

              for (const refTag of refTags) {
                yield buildCall('advance', buildEmbeddedTag(refTag));
              }

              if (start) {
                yield buildCall('advance', buildEmbeddedTag(start));
              }
            }

            // how should we continue?
            if (selfClosing) {
              if (!shouldInterpolate) {
                for (const tag of intrinsicResult.children) {
                  if (tag.type === OpenFragmentTag || tag.type === CloseFragmentTag) continue;
                  yield buildCall('advance', buildEmbeddedTag(tag));
                }

                yield buildCall('advance', buildEmbeddedTag(buildCloseNodeTag()));
              }

              const finishedMatch = m;

              yield buildCall('endFrame');

              m = m.parent;

              returnValue = finishedMatch.node;
            } else if (!shouldInterpolate) {
              const sourceProps = btree.getAt(
                1,
                getRoot(sourceInstr).properties.arguments.node.properties.values,
              )?.node;

              co = buildCoroutine(ctx, s, m, sourceProps, intrinsicResult);

              let prevTagPath = s.referencePath || previousPath;

              if ([CloseNodeTag, NullTag, GapTag].includes(prevTagPath.tag.type)) {
                prevTagPath = m.path.parent
                  ? TagPath.from(m.path.parent, -1)
                  : TagPath.from(m.path, 0);
              }

              co.advance();

              returnValue = defer;
            } else {
              throw new Error('not implemented');
            }
          } else if (isString(matcher) || isRegexPattern || matcher.nodeMatcher.type === sym.gap) {
            let result;

            if (isRegexPattern || matcher.nodeMatcher?.type === sym.gap) {
              result = yield buildCall(
                'match',
                buildEmbeddedNode(
                  matcher.nodeMatcher?.type === sym.gap
                    ? buildPattern(buildAlternatives([buildRegexGap()]), buildNodeFlags())
                    : matcher,
                ),
              );
            } else {
              result = yield buildCall('match', matcher);
            }

            if ((!result && effects.failure === 'fail') || (result && effects.success === 'fail')) {
              throwing = true;
              break instrLoop;
            }

            if (result && effects.success === 'eat') {
              if (matcher.type === sym.gap) {
                const { name, isArray, hasGap } = parsedResolvedPath;

                if (isArray) {
                  yield buildCall(
                    'advance',
                    buildEmbeddedTag(
                      buildReferenceTag(name, true, freeze({ expression: false, hasGap })),
                    ),
                  );

                  yield buildCall('advance', buildEmbeddedTag(buildArrayInitializerTag()));
                }

                yield buildCall(
                  'advance',
                  buildEmbeddedTag(buildReferenceTag(name, isArray, hasGap)),
                );
              }

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
          throwing = true;
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
      } else if (!co.done) {
        co.advance(returnValue);
      }
    } // end instrLoop

    {
      // resume suspended execution
      const { type, isNode, grammar, matcher, captured, effects } = m;
      const allowEmpty = !!grammar.emptyables?.has(type);
      const isThrowing = throwing;
      const finishedMatch = m;

      zombie = !co.done;

      if (zombie) {
        co.finalize();
        alreadyAdvanced = true;
        continue;
      }

      if (co.value) {
        // there is a return value to process
        processingReturn = true;
        alreadyAdvanced = true;
        continue;
      }

      if (captured) throw new Error();

      let isEmpty_ = isEmpty(
        allTagsFor(
          isNode
            ? [btree.getSum(m.innerPath.node.children) ? new TagPath(m.innerPath, 0) : null, null]
            : m.range,
        ),
      );

      let failing = isThrowing || (!allowEmpty && isEmpty_);
      throwing = !shouldBranch(effects) && failing;

      if (isNode && !failing) {
        yield buildCall('advance', buildEmbeddedTag(buildCloseNodeTag()));
      }

      if (finishedMatch.depth === 0 && !failing) {
        yield buildCall('advance', buildEmbeddedTag(buildFragmentCloseTag()));
      }

      // && (!m.parent || finishedMatch.s === m.s);

      if (isThrowing) {
        yield buildCall('throw');
      } else {
        yield buildCall('endFrame');
      }

      m = m.parent;

      let { range } = finishedMatch;

      if (m) {
        s = m.state;
      }

      if (finishedMatch.depth === 0) {
        if (!throwing && range) {
          const m = finishedMatch;

          if (!m.state.source.done) {
            throw new Error(
              `parse ate ${m.state.source.index} characters but the input was not consumed`,
            );
          }

          return m.range;
        } else {
          throw new Error(`parse failed after ${finishedMatch.state.source.index} characters`);
        }
      }

      co = coroutines.get(m);

      if (throwing && !m.captured) {
        co.finalize();
        alreadyAdvanced = true;
      }

      matchReturnValue = failing ? null : finishedMatch.node;
      continue;
    }
  }
}
