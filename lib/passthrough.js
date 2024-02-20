import { buildCall, buildExpression as expr } from '@bablr/agast-vm-helpers';
import { printPath } from '@bablr/agast-helpers/path';

function* passthroughStrategy(tokens) {
  yield buildCall('startNode', expr(null), expr(null));

  for (const token of tokens) {
    switch (token.type) {
      case 'OpenFragmentTag': {
        const { flags } = token.value;

        yield buildCall('startNode', expr(flags), expr(null));
        break;
      }

      case 'OpenNodeTag': {
        const { flags, type, attributes } = token.value;

        yield buildCall('startNode', expr(flags), expr(type), expr(attributes));
        break;
      }

      case 'CloseNodeTag': {
        yield buildCall('endNode', expr(token.value.type));
        break;
      }

      case 'CloseFragmentTag': {
        yield buildCall('endNode', expr(null));
        break;
      }

      case 'Reference': {
        yield buildCall('reference', expr(printPath(token.value)));
        break;
      }

      case 'Literal': {
        yield buildCall('advance', expr(token.value));
        break;
      }

      default:
        throw new Error();
    }
  }

  yield buildCall('endNode', null);
}

export const createPassthroughStrategy = (tokens) => {
  return () => passthroughStrategy(tokens);
};
