import isString from 'iter-tools-es/methods/is-string';
import {
  effectsFor,
  shouldBranch,
  reifyExpression,
  reifyExpressionShallow,
  buildGap,
  buildNull,
  buildCall,
  buildObject,
  buildLiteral,
  buildReference,
  buildDoctypeTag,
  buildNodeOpenTag,
  buildNodeCloseTag,
  buildFragmentOpenTag,
  buildFragmentCloseTag,
} from '@bablr/agast-vm-helpers';
import { getProduction, resolveLanguage } from '@bablr/helpers/grammar';
import { printPath, parsePath } from '@bablr/agast-helpers/path';
import { StreamGenerator } from '@bablr/agast-helpers/stream';
import { Match } from './match.js';

const { hasOwn } = Object;

const nodeTopType = Symbol.for('@bablr/node');
const fragmentType = Symbol.for('@bablr/fragment');
const defer = Symbol('defer');

function* parseStrategy(rootLanguage, rootMatcher, rootProps, productionEnhancer, s, ctx) {
  let m = Match.from(ctx, ctx.languages.get(rootLanguage), s, rootMatcher, productionEnhancer);
  let matchReturnValue = undefined;

  yield buildCall('advance', buildDoctypeTag({ 'bablr-language': rootLanguage }));

  yield buildCall('advance', buildFragmentOpenTag());

  m.range[0] = s.result;

  if (getProduction(ctx.grammars.get(ctx.languages.get(rootLanguage)), fragmentType)) {
    m = m.exec(s, effectsFor('eat'), { type: fragmentType });
  } else {
    m = m.exec(s, effectsFor('eat'), reifyExpression(rootMatcher), rootProps);
  }

  while (m.co) {
    m.co.advance(matchReturnValue);

    matchReturnValue = undefined;

    instrLoop: for (;;) {
      if (m.co.current instanceof Promise) {
        m.co.current = yield m.co.current;
      }

      if (m.co.done) break;

      const sourceInstr = m.co.value;
      const instr = reifyExpression(sourceInstr);
      const { verb, arguments: args } = instr;

      let returnValue = undefined;

      switch (verb) {
        case 'eat':
        case 'eatMatch':
        case 'match':
        case 'guard': {
          const effects = effectsFor(verb);
          let { 0: matcher, 1: path, 2: props } = args;
          let start;

          if (m.depth === 1 && matcher?.type === 'Gap') {
            matcher = reifyExpression(rootMatcher);
          }

          // Do something better here pls
          const isRegexPattern =
            matcher &&
            matcher.type === 'Pattern' &&
            matcher.language === 'https://bablr.org/languages/offical/regex-vm-pattern';

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
            if (s.path.depth === 1 && !s.path.startTag) {
              // can i move this block somewhere else?
              // there could be trivia between here and openFragmentTag
              const { language: tagLanguage, type } = reifyExpression(rootMatcher);

              const resolvedLanguage = resolveLanguage(m.language, tagLanguage);

              const grammar = ctx.grammars.get(resolvedLanguage);
              const isNode = grammar.covers.get(nodeTopType).has(type);
              const isCover = grammar.covers.has(type);

              if (isNode && !isCover) {
                yield buildCall('advance', buildNodeOpenTag({}, tagLanguage, type));
              }
            }

            const { flags, language: tagLanguage, type, attributes } = matcher;

            const resolvedLanguage = resolveLanguage(m.language, tagLanguage);

            if (tagLanguage && !resolvedLanguage) {
              throw new Error('Unresolvable language');
            }

            const grammar = ctx.grammars.get(resolvedLanguage);
            const isNode = grammar.covers.get(nodeTopType).has(type);
            const isCover = grammar.covers.has(type);
            const atGap = s.source.atGap && !flags.trivia;
            const isHoldable = !!grammar.holdables?.has(type);

            if (shouldBranch(effects)) {
              s = yield buildCall('branch');
            }

            if (
              (isNode || isCover) &&
              s.result?.type !== 'Reference' &&
              s.result?.type !== 'OpenFragmentTag' &&
              !flags.trivia &&
              !flags.escape &&
              effects.success === 'eat'
            ) {
              if (path && m.declaredPath) throw new Error();

              const strPath =
                isNode || isCover
                  ? !path || path.type === 'Null'
                    ? m.declaredPath || printPath(m.path.reference?.value) || 'root'
                    : reifyExpression(path)
                  : null;
              const { name, isArray } = parsePath(strPath);

              yield buildCall('advance', buildReference(name, isArray));
            }

            if ((atGap && isNode) || isCover) {
              start = yield buildCall('advance', buildGap());
            } else if (isNode && !isCover) {
              if (isHoldable) {
                throw new Error('not implemented');
              }

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

              start = yield buildCall('advance', buildNodeOpenTag(flags, path, type, attributes_));
            }

            if (!atGap) {
              if (!isNode && tagLanguage) {
                m.languageRelativePath = m.languageRelativePath.push(tagLanguage);
              }

              const sourceArgs = sourceInstr.properties.arguments.properties.values;
              const sourceMatcher = sourceArgs[0];

              let props_ = sourceArgs[2];

              if (flags.token) {
                // TODO unsafe: props don't have to be an object
                props_ = buildObject({
                  ...reifyExpressionShallow(props_),
                  value: sourceMatcher.properties.value,
                });
              }

              m = m.exec(s, effects, matcher, props_);

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

            if (!result && effects.failure === 'fail') {
              s = yield buildCall('reject');
              break instrLoop;
            }

            if (result) {
              if (effects.success === 'eat') {
                start = yield buildCall('advance', buildLiteral(result));
              } else {
                start = buildLiteral(result);
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
      const { path, type, grammar, startTag, effects } = m;
      const failed = m.s !== s;
      const allowEmpty = !!grammar.emptyables?.has(type);
      const isNode = m.grammar.covers.get(nodeTopType).has(type);
      const isCover = m.grammar.covers.has(type);

      if (!(failed || (m.empty && !allowEmpty)) && isNode && !isCover) {
        yield buildCall('advance', buildNodeCloseTag(type, startTag.value.language));
      }

      const range = failed ? null : m.endCapture();

      const completedMatch = m;

      m = m.collect();

      const isNode_ = completedMatch.path.depth !== m.path?.depth;

      if (!isNode_ && m.language !== completedMatch.language) {
        m.languageRelativePath = completedMatch.languageRelativePath.pop();
      }

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

export const createParseStrategy = (
  rootLanguage,
  rootMatcher,
  rootProps,
  productionEnhancer = (p) => p,
) => {
  return (...args) =>
    new StreamGenerator(
      parseStrategy(rootLanguage, rootMatcher, rootProps, productionEnhancer, ...args),
    );
};
