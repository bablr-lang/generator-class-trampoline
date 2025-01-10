import isString from 'iter-tools-es/methods/is-string';
import {
  effectsFor,
  reifyExpression,
  buildPattern,
  buildAlternatives,
  buildRegexGap,
  buildNodeFlags,
  buildBasicNodeMatcher,
  buildFragmentMatcher,
  buildPropertyMatcher,
  buildReferenceMatcher,
  buildReferenceFlags,
  shouldBranch,
} from '@bablr/agast-vm-helpers';
import {
  buildEmbeddedObject,
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
  buildOpenNodeTag,
  buildCloseNodeTag,
  buildArrayInitializerTag,
  buildFragmentCloseTag,
  referenceFlags,
  buildFragmentOpenTag,
  nodeFlags,
  getFlagsWithGap,
} from '@bablr/agast-helpers/builders';
import { resolveLanguage, unresolveLanguage } from '@bablr/helpers/grammar';
import { isEmpty, StreamGenerator } from '@bablr/agast-helpers/stream';
import { getCooked, getRoot, isNull, mergeReferences } from '@bablr/agast-helpers/tree';
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
import { buildCoroutine, coroutines, FragmentFacade } from './match.js';

const { freeze } = Object;

const { hasOwn } = Object;

const nodeTopType = Symbol.for('@bablr/node');
const defer = Symbol('defer');

export const createParseStrategy = (rootMatcher, rootProps) => {
  return (s, ctx) => {
    return new StreamGenerator(parseStrategy(ctx, rootMatcher, rootProps, s));
  };
};

// function* throw_(rejectedState, rejectedM) {
//   const s = rejectedState.parent;

//   let ref = null;

//   // if (
//   //   s &&
//   //   s.path.depth &&
//   //   rejectedState.path.depth >= s.path.depth &&
//   //   (rejectedM.pathName || rejectedM.declaredPath)
//   // ) {
//   //   const didShift = !!nodeForRef(s.path) && !nodeForRef(rejectedState.path.at(s.path.depth));

//   //   const lowPath = rejectedState.path.at(
//   //     Math.min(
//   //       s.path.depth + (didShift || s.result.child.type === ReferenceTag ? 0 : 1),
//   //       rejectedState.path.depth,
//   //     ),
//   //   );
//   //   const lowNode = s.node || s.parentNode;

//   //   const { name, isArray, hasGap } = lowPath.reference?.value || {};

//   //   if (
//   //     !didShift &&
//   //     !lowNode.has(name) &&
//   //     !(s.result.type === ReferenceTag && s.result.value.name === name)
//   //   ) {
//   //     ref = buildReferenceTag(name, isArray, { hasGap });
//   //   }
//   // }

//   if (ref && ref.value.name !== '#') {
//     yield buildCall('advance', buildEmbeddedTag(ref));

//     if (ref.value.isArray) {
//       yield buildCall('advance', buildEmbeddedTag(buildArrayInitializerTag()));
//     } else {
//       yield buildCall('advance', buildEmbeddedTag(buildNullTag()));
//     }
//   }

//   return { s: m.s, m, throwing: true };
// }

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

    yield buildCall(
      'advance',
      buildEmbeddedTag(buildDoctypeTag({ 'bablr-language': canonicalURL })),
    );

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

            if (!matcher || !matcher.nodeMatcher.type || isRegexPattern) {
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

            const previous = s.result;

            const selfClosing = intrinsicValue && flags.token;

            // const resolvedLanguage = resolveLanguage(ctx, m.language, tagLanguage);
            const language = resolveLanguage(ctx, m.language, tagLanguage);

            if (tagLanguage && !language) {
              throw new Error(`Unresolvable language ${tagLanguage}`);
            }

            const grammar = ctx.grammars.get(language);
            const isNode = grammar.covers?.get(nodeTopType).has(type) && !options?.suppressNode;
            const isCover = grammar.covers?.has(type);
            const atGap = s.source.atGap && !flags.trivia;
            const shouldInterpolate =
              atGap &&
              (isNode || isCover) &&
              parsedResolvedPath?.value.hasGap &&
              !options?.suppressGap;

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
                    !(s.result.child.type === ReferenceTag && s.result.child.value.name === name)
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
            let mergedReference =
              !m.isNode && !['#', '@'].includes(ownReference.value.name)
                ? mergeReferences(m.mergedReference, ownReference)
                : ownReference;

            let refTags = [];

            // advance reference?
            if (!isHold && isNode && effects.success === 'eat' && !s.reference) {
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
              ({ s } = m);

              for (const refTag of refTags) {
                yield buildCall('advance', buildEmbeddedTag(refTag));
              }

              if (start) {
                yield buildCall('advance', buildEmbeddedTag(start));
              }
            }

            // how should we continue?
            if (selfClosing) {
              for (const tag of intrinsicResult.children) {
                if (tag.type === OpenFragmentTag || tag.type === CloseFragmentTag) continue;
                yield buildCall('advance', buildEmbeddedTag(tag));
              }

              const { node } = s;

              yield buildCall('advance', buildEmbeddedTag(buildCloseNodeTag()));

              m = yield buildCall('endFrame');

              returnValue = node;
            } else if (!shouldInterpolate) {
              const sourceProps = btree.getAt(
                1,
                getRoot(sourceInstr).properties.arguments.node.properties.values,
              )?.node;

              // is this check specific enough to detect the return pathway?
              if (co.done) {
                m = m.parent; // replace the current stack frame -- tail call optimization
              }

              co = buildCoroutine(ctx, s, m, sourceProps, intrinsicResult);

              let prevTagPath = shift || s.referencePath || previous;

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
      const wasThrowing = throwing;
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

      let isEmpty_ = isEmpty(allTagsFor(m.range));

      let failing = wasThrowing || (!allowEmpty && isEmpty_);
      throwing = !shouldBranch(effects) && failing;

      if (isNode && !failing) {
        yield buildCall('advance', buildEmbeddedTag(buildCloseNodeTag()));
      }

      if (finishedMatch.depth === 0 && !failing) {
        yield buildCall('advance', buildEmbeddedTag(buildFragmentCloseTag()));
      }

      // && (!m.parent || finishedMatch.s === m.s);

      if (wasThrowing) {
        m = yield buildCall('throw');
      } else {
        m = yield buildCall('endFrame');
      }

      let { range } = finishedMatch;

      if (m) {
        ({ s } = m);
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

      matchReturnValue =
        throwing || finishedMatch.rangePreviousIndex == null
          ? null
          : new FragmentFacade(
              finishedMatch.parent.path,
              [finishedMatch.rangePreviousIndex, finishedMatch.rangeFinalIndex],
              finishedMatch.pathName || '.',
            );
      continue;
    }
  }
}
