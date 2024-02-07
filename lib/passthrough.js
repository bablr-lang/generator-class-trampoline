import { buildCall, buildString } from '@bablr/agast-vm-helpers';
import { printPath } from '@bablr/agast-helpers';

export function* createPassthroughTrampoline(tokens) {
  yield buildCall('startNode', null, null);

  for (const token of tokens) {
    switch (token.type) {
      case 'OpenNodeTag': {
        const { flags, type, attributes } = token.value;

        yield buildCall('startNode', flags, type, attributes);
        break;
      }

      case 'CloseNodeTag': {
        yield buildCall('endNode', token.value.type);
        break;
      }

      case 'Reference': {
        yield buildCall('reference', printPath(token.value));
        break;
      }

      case 'Literal': {
        yield buildCall('eat', buildString(token.value));
        break;
      }
    }
  }

  yield buildCall('endNode', null);
}
