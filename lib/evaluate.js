import isString from 'iter-tools-es/methods/is-string';
import {
  effectsFor,
  shouldBranch,
  reifyExpression,
  buildPattern,
  buildAlternatives,
  buildRegexGap,
  buildNodeFlags,
} from '@bablr/agast-vm-helpers';
import {
  buildEmbeddedObject,
  buildEmbeddedNode,
  buildEmbeddedTag,
} from '@bablr/agast-vm-helpers/internal-builders';
import { embedExpression } from '@bablr/agast-vm-helpers/embed';
import { concat, takeWhile, reduce, map } from '@bablr/agast-vm-helpers/iterable';
import {
  buildCall,
  buildGapTag,
  buildShiftTag,
  buildNullTag,
  buildReferenceTag,
  buildDoctypeTag,
  buildNodeOpenTag,
  buildNodeCloseTag,
  buildArrayInitializerTag,
  buildFragmentCloseTag,
  referenceFlags,
  buildFragmentOpenTag,
} from '@bablr/agast-helpers/builders';
import { resolveLanguage, unresolveLanguage } from '@bablr/helpers/grammar';
import { parseRef } from '@bablr/agast-helpers/shorthand';
import { isEmpty, StreamGenerator } from '@bablr/agast-helpers/stream';
import { getCooked, getRoot, isNull, mergeReferences } from '@bablr/agast-helpers/tree';
import * as btree from '@bablr/agast-helpers/btree';
import {
  ReferenceTag,
  OpenFragmentTag,
  CloseFragmentTag,
  OpenNodeTag,
  CloseNodeTag,
  NullTag,
  GapTag,
} from '@bablr/agast-helpers/symbols';
import * as sym from '@bablr/agast-helpers/symbols';
import { buildCoroutine, coroutines } from './match.js';
import { allTagsFor, TagPath } from '@bablr/agast-helpers/path';

const states = new WeakMap();

export class FragmentFacade {
  constructor(path, childrenIndexRange, dotPropertyName) {
    if (childrenIndexRange[0] == null || !childrenIndexRange[1] == null) {
      throw new Error();
    }

    const openTag = btree.getAt(childrenIndexRange[0], path.node.children);

    let isNode = openTag.type === sym.OpenNodeTag;
    let isNull = openTag.type === NullTag;

    states.set(this, {
      openTag: isNode || isNull ? null : buildFragmentOpenTag(),
      closeTag: isNode || isNull ? null : buildFragmentCloseTag(),
      path,
      childrenIndexRange,
      dotPropertyName,
    });
  }

  get isTransparent() {
    return true;
  }

  get isNode() {
    const { openTag } = this;
    return openTag.type === OpenNodeTag;
  }

  get children() {
    const { path, childrenIndexRange, openTag, closeTag } = states.get(this);

    return {
      *[Symbol.iterator]() {
        if (openTag) yield openTag;

        if (childrenIndexRange[0] > childrenIndexRange[1]) throw new Error();

        for (let i = childrenIndexRange[0]; i <= childrenIndexRange[1]; i++) {
          yield btree.getAt(i, path.node.children);
        }

        if (closeTag) yield closeTag;
      },
    };
  }

  get flags() {
    const { openTag } = this;
    return openTag.type === OpenNodeTag
      ? openTag.value.flags
      : openTag.type === sym.OpenFragmentTag
      ? // redundant value accessor for monomorphism
        openTag.value.flags
      : null;
  }

  get language() {
    const { openTag } = this;
    return openTag.type === OpenNodeTag ? openTag.value.language : null;
  }

  get type() {
    const { openTag } = this;
    return openTag.type === OpenNodeTag
      ? openTag.value.type
      : openTag.type === NullTag
      ? sym.null
      : null;
  }

  get attributes() {
    return this.openTag.attributes;
  }

  get openTag() {
    const state = states.get(this);
    const { children } = state.path.node;

    return state.openTag || btree.getAt(0, children);
  }

  get closeTag() {
    const state = states.get(this);
    const { children } = state.path.node;

    return state.closeTag || btree.getAt(btree.getSum(children) - 1, children);
  }

  getRootIndex() {
    const { path, dotPropertyName, childrenIndexRange } = states.get(this);
    const { node } = path;

    if (childrenIndexRange[0] > childrenIndexRange[1]) throw new Error();

    for (let i = childrenIndexRange[0]; i <= childrenIndexRange[1]; i++) {
      let tag = btree.getAt(i, node.children);
      if (tag.type === ReferenceTag) {
        const { name, isArray } = tag.value;
        let resolvedTagName = name === '.' ? dotPropertyName : name;

        if (resolvedTagName === dotPropertyName) {
          return i;
        }
      }
    }

    return null;
  }

  get(name, index = null) {
    let { path, dotPropertyName } = states.get(this);

    if (!this.isNode) {
      let dotChildrenIndex = this.getRootIndex();
      let dotIndex = path.referenceIndexes[dotChildrenIndex];
      let dotReference = buildReferenceTag(
        dotPropertyName,
        dotIndex != null,
        referenceFlags,
        dotIndex,
      );

      path = path.get(dotReference);
    }

    let newPath = path.get(buildReferenceTag(name, index != null, referenceFlags, index));

    // if (newPath.node.type === sym.null) throw new Error();

    return new FragmentFacade(newPath, [0, btree.getSum(newPath.node.children) - 1], name);
  }

  has(path) {
    throw new Error('not implemented');
  }
}

Object.seal(FragmentFacade);

const { hasOwn } = Object;

const nodeTopType = Symbol.for('@bablr/node');
const defer = Symbol('defer');

export const createParseStrategy = (rootMatcher, rootProps) => {
  return (s, ctx) => {
    return new StreamGenerator(parseStrategy(ctx, rootMatcher, rootProps, s));
  };
};

function* reject(rejectedState, rejectedM) {
  const s = rejectedState.parent;

  let ref = null;

  // if (
  //   s &&
  //   s.path.depth &&
  //   rejectedState.path.depth >= s.path.depth &&
  //   (rejectedM.pathName || rejectedM.declaredPath)
  // ) {
  //   const didShift = !!nodeForRef(s.path) && !nodeForRef(rejectedState.path.at(s.path.depth));

  //   const lowPath = rejectedState.path.at(
  //     Math.min(
  //       s.path.depth + (didShift || s.result.child.type === ReferenceTag ? 0 : 1),
  //       rejectedState.path.depth,
  //     ),
  //   );
  //   const lowNode = s.node || s.parentNode;

  //   const { name, isArray, hasGap } = lowPath.reference?.value || {};

  //   if (
  //     !didShift &&
  //     !lowNode.has(name) &&
  //     !(s.result.type === ReferenceTag && s.result.value.name === name)
  //   ) {
  //     ref = buildReferenceTag(name, isArray, { hasGap });
  //   }
  // }

  yield buildCall('reject');

  if (ref && ref.value.name !== '#') {
    yield buildCall('advance', buildEmbeddedTag(ref));

    if (ref.value.isArray) {
      yield buildCall('advance', buildEmbeddedTag(buildArrayInitializerTag()));
    } else {
      yield buildCall('advance', buildEmbeddedTag(buildNullTag()));
    }
  }

  return s;
}

function* parseStrategy(ctx, rootMatcher, rootValue, s) {
  const gapsAllowed = !isNull(
    getRoot(rootMatcher).properties.nodeMatcher.node.properties.open.node.properties.flags?.node
      .properties.hasGapToken,
  );

  let matchReturnValue = undefined;
  let processingReturn = false;
  let alreadyAdvanced = false;

  yield buildCall(
    'advance',
    buildEmbeddedTag(
      buildDoctypeTag({
        'bablr-language': getCooked(
          getRoot(rootMatcher).properties.nodeMatcher.node.properties.open.node.properties.language
            ?.node.properties.content.node,
        ),
      }),
    ),
  );

  yield buildCall('advance', buildEmbeddedTag(buildFragmentOpenTag()));

  let m = yield buildCall(
    'startFrame',
    buildEmbeddedNode(getRoot(rootMatcher)),
    buildEmbeddedObject(effectsFor('eat')),
    buildEmbeddedObject(rootValue),
  );

  let co = buildCoroutine(ctx, s, m);

  if (m.path !== s.result.path) throw new Error();

  while (co) {
    if (!co.done && !alreadyAdvanced) {
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

            if (!matcher || !matcher.type || isRegexPattern) {
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
              ? m.declaredPath ||
                parsedPath || { name: '.', isArray: false, index: null, flags: referenceFlags }
              : parsedPath;

          if (!isRegexPattern && matcher.type !== sym.gap && !isString(matcher)) {
            const { refMatcher, nodeMatcher } = matcher;
            const sourceNodeMatcher = getRoot(sourceMatcher).properties.nodeMatcher.node;

            if (sourceNodeMatcher.type === Symbol.for('ArrayNodeMatcher')) {
              const { name, isArray, hasGap } = parsedResolvedPath;

              if (!isArray && name !== '.') throw new Error();

              if (!s.node.has(name)) {
                yield buildCall(
                  'advance',
                  buildEmbeddedTag(
                    buildReferenceTag(name, true, { hasGap: gapsAllowed && hasGap }),
                  ),
                );
                start = yield buildCall('advance', buildEmbeddedTag(buildArrayInitializerTag()));
              }

              returnValue = start;
              break;
            } else if (sourceNodeMatcher.type === Symbol.for('NullNodeMatcher')) {
              if (parsedResolvedPath && effects.success === 'eat') {
                const { name, isArray, hasGap } = parsedResolvedPath;

                if (!s.node.has(name)) {
                  yield buildCall(
                    'advance',
                    buildEmbeddedTag(
                      buildReferenceTag(name, isArray, { hasGap: gapsAllowed && hasGap }),
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
            const absoluteLanguage = language.canonicalURL;

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
                s = yield* reject(s, m);

                break instrLoop;
              } else if (!intrinsicResult) {
                if ((isNode || isCover) && refMatcher && refMatcher.name !== '.') {
                  if (!parsedResolvedPath) {
                    throw new Error(`language failed to specify a path for node of type ${type}`);
                  }

                  const { name, isArray, hasGap } = parsedResolvedPath;

                  // this is copy pasta
                  if (
                    s.node &&
                    !s.node.has(name) &&
                    !(s.result.child.type === ReferenceTag && s.result.child.value.name === name)
                  ) {
                    if (name !== '#' && name !== '@') {
                      yield buildCall(
                        'advance',
                        buildEmbeddedTag(
                          buildReferenceTag(name, isArray, { hasGap: gapsAllowed && hasGap }),
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

            // advance reference?
            if (!isHold && isNode && effects.success === 'eat' && !s.reference) {
              let innerParsedResolvedPath =
                isNode || isCover
                  ? parsedResolvedPath ||
                    m.declaredPath ||
                    (s.path.depth ? s.path.reference : parseRef('.'))
                  : null;

              const { name, isArray, hasGap } = innerParsedResolvedPath;

              if (isArray && !s.node.has(name)) {
                yield buildCall(
                  'advance',
                  buildEmbeddedTag(
                    buildReferenceTag(name, true, { hasGap: gapsAllowed && hasGap }),
                  ),
                );
                yield buildCall('advance', buildEmbeddedTag(buildArrayInitializerTag()));
              }

              const mergedReference =
                reduce(
                  (a, b) => {
                    return a == null ? b : mergeReferences(a, b);
                  },
                  [
                    ...concat(
                      [buildReferenceTag(name, isArray, { hasGap: gapsAllowed && hasGap })],
                      map(
                        (m) => {
                          if (!m.propertyMatcher?.refMatcher) {
                            return buildReferenceTag('.');
                          } else {
                            const { name, isArray, flags } = m.propertyMatcher.refMatcher;
                            return buildReferenceTag(name, isArray, flags);
                          }
                        },
                        takeWhile((m) => !m.isNode, m.ancestors(true)),
                      ),
                    ),
                  ].reverse(),
                ) || buildReferenceTag('.');

              yield buildCall('advance', buildEmbeddedTag(mergedReference));
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

              start = buildNodeOpenTag(
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
              );
            }

            {
              let resolvedMatcher =
                matcher.nodeMatcher.open.type === '?' ? rootMatcher : sourceMatcher;

              const unboundAttributes = hasOwn(grammar, 'unboundAttributes')
                ? grammar.unboundAttributes.get(type) || []
                : [];

              if (parsedResolvedPath.name === '@') {
                unboundAttributes.push('cooked');
              }
              const options = buildEmbeddedObject({ unboundAttributes });

              m = yield buildCall(
                'startFrame',
                buildEmbeddedNode(resolvedMatcher),
                buildEmbeddedObject(intrinsicValue ? effectsFor('eat') : effects),
                ...(unboundAttributes.length ? [options] : []),
              );
              ({ s } = m);

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

              yield buildCall(
                'advance',
                buildEmbeddedTag(buildNodeCloseTag(Symbol.for(type), nodeMatcher.open.language)),
              );

              m = yield buildCall('endFrame');

              returnValue = node;
            } else if (!shouldInterpolate) {
              const sourceProps = btree.getAt(
                1,
                getRoot(sourceInstr).properties.arguments.node.properties.values,
              )?.node;

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

              if (refMatcher && !isNode) {
                if (m.declaredPath && !parsedPath.name === '.') {
                  throw new Error('double-specified path');
                }

                m.declaredPath = parsedPath;
              }

              co.advance();

              returnValue = defer;
            } else {
              throw new Error('not implemented');
            }
          } else if (isString(matcher) || isRegexPattern || matcher.type === sym.gap) {
            let result;

            if (isRegexPattern || matcher.type === sym.gap) {
              result = yield buildCall(
                'match',
                buildEmbeddedNode(
                  matcher.type === sym.gap
                    ? buildPattern(buildAlternatives([buildRegexGap()]), buildNodeFlags())
                    : matcher,
                ),
              );
            } else {
              result = yield buildCall('match', matcher);
            }

            if ((!result && effects.failure === 'fail') || (result && effects.success === 'fail')) {
              s = yield* reject(s, m);
              break instrLoop;
            }

            if (result && effects.success === 'eat') {
              if (matcher.type === sym.gap) {
                const { name, isArray, hasGap } = parsedResolvedPath;

                if (isArray) {
                  yield buildCall(
                    'advance',
                    buildEmbeddedTag(buildReferenceTag(name, true, hasGap)),
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
          s = yield* reject(s, m);
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
      const finishedMatch = m;
      // resume suspended execution

      const { type, isNode, grammar, matcher, captured, zombie, effects } = m;
      const allowEmpty = !!grammar.emptyables?.has(type);
      const wasRejected = m.s !== s;

      if (!zombie && !wasRejected && isNode && !captured) {
        yield buildCall(
          'advance',
          buildEmbeddedTag(buildNodeCloseTag(Symbol.for(type), matcher.language)),
        );
      }

      let range, throwing;

      if (!zombie) {
        if (captured) throw new Error();

        m = yield buildCall('endFrame');
        ({ s } = m);

        co.finalize();

        ({ range } = finishedMatch);

        throwing = (wasRejected || (!allowEmpty && !range)) && finishedMatch.s === m.s;

        if (!co.done) {
          // Zombie
          alreadyAdvanced = true;
          continue;
        } else if (co.value) {
          // there is a return value to process
          processingReturn = true;
          continue;
        }
      } else {
        if (!co.done) throw new Error();
      }

      co = coroutines.get(m);

      if (m.s !== s) {
        co.finalize();

        if (!co.done) {
          // Zombie
          alreadyAdvanced = true;
          continue;
        } else if (co.value) {
          // there is a return value to process
          processingReturn = true;
          continue;
        }
      }

      if (co) {
        matchReturnValue =
          throwing || finishedMatch.rangePreviousIndex == null
            ? null
            : new FragmentFacade(
                finishedMatch.parent.path,
                [finishedMatch.rangePreviousIndex, finishedMatch.rangeFinalIndex],
                finishedMatch.declaredPath?.name ||
                  finishedMatch.propertyMatcher.refMatcher?.name ||
                  '.',
              );
        continue;
      } else {
        if (!throwing && range) {
          yield buildCall('advance', buildEmbeddedTag(buildFragmentCloseTag()));

          if (m.depth !== 0) throw new Error();

          // m.leftSkewedRange[1] = s.result;

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
