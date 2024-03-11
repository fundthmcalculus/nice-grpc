import {forever, isAbortError} from 'abort-controller-x';
import {assertNever} from 'assert-never';
import {detect} from 'detect-browser';
import cartesianProduct from 'just-cartesian-product';
import {ServerError} from 'nice-grpc-common';
import {
  ClientError,
  createChannel,
  createClient,
  FetchTransport,
  Metadata,
  Status,
  WebsocketTransport,
} from '..';
import {
  TestClient,
  TestDefinition,
  TestRequest,
  TestServiceImplementation,
} from '../../fixtures/ts-proto/test';
import {
  RemoteTestServer,
  startRemoteTestServer,
} from '../../test-server/client';
import {NodeHttpTransport} from '../client/transports/nodeHttp';
import {defer} from './utils/defer';

const environment = detect();

[
  ...cartesianProduct([
    ['envoy' as const, 'grpcwebproxy' as const, 'traefik' as const],
    ['fetch' as const, 'node-http' as const],
    ['http' as const, 'https' as const],
  ]),
  ['grpcwebproxy', 'websocket', 'http'] as const,
].forEach(([proxyType, transport, protocol]) => {
  if (
    process.env.FORCE_ALL_TESTS !== 'true' &&
    transport === 'fetch' &&
    (environment?.name === 'safari' ||
      environment?.name === 'ios' ||
      environment?.name === 'firefox' ||
      (environment?.name === 'chrome' && environment.os === 'Android OS') ||
      (environment?.name === 'chrome' && parseInt(environment.version) < 105) ||
      (environment?.name === 'chrome' && protocol === 'http') ||
      (environment?.name === 'edge-chromium' && protocol === 'http'))
  ) {
    // safari does not support constructing readable streams
    // most browsers do not support sending readable streams

    // chromium requires http2 (hence https) to send client streams

    return;
  }

  if (transport === 'node-http' && environment?.type !== 'node') {
    return;
  }

  describe(`clientStreaming / ${proxyType} / ${transport} / ${protocol}`, () => {
    let server: RemoteTestServer;
    let init: (
      mockImplementation: Partial<TestServiceImplementation>,
    ) => Promise<TestClient>;

    beforeEach(() => {
      init = async impl => {
        server = await startRemoteTestServer(impl, proxyType, protocol);

        return createClient(
          TestDefinition,
          createChannel(
            server.address,
            transport === 'fetch'
              ? FetchTransport()
              : transport === 'websocket'
              ? WebsocketTransport()
              : transport === 'node-http'
              ? NodeHttpTransport()
              : assertNever(transport),
          ),
        );
      };
    });

    afterEach(() => {
      server?.shutdown();
    });

    it('sends multiple requests and receives a response', async () => {
      const client = await init({
        async testClientStream(request, context) {
          context.header.set('test', 'test-header');
          context.trailer.set('test', 'test-trailer');

          const requests: TestRequest[] = [];

          for await (const req of request) {
            requests.push(req);
          }

          return {
            id: requests.map(request => request.id).join(' '),
          };
        },
      });

      let header: Metadata | undefined;
      let trailer: Metadata | undefined;

      async function* createRequest() {
        yield {id: 'test-1'};
        yield {id: 'test-2'};
      }

      expect(
        await client.testClientStream(createRequest(), {
          onHeader(header_) {
            header = header_;
          },
          onTrailer(trailer_) {
            trailer = trailer_;
          },
        }),
      ).toEqual({
        id: 'test-1 test-2',
      });

      expect(header?.get('test')).toEqual('test-header');
      expect(trailer?.get('test')).toEqual('test-trailer');
    });

    it('receives an error', async () => {
      const client = await init({
        async testClientStream(request, context) {
          context.header.set('test', 'test-header');
          context.trailer.set('test', 'test-trailer');

          for await (const item of request) {
            throw new ServerError(Status.NOT_FOUND, item.id);
          }

          return {};
        },
      });

      let header: Metadata | undefined;
      let trailer: Metadata | undefined;
      let error: unknown;

      async function* createRequest() {
        yield {id: 'test-1'};
        yield {id: 'test-2'};
      }

      try {
        await client.testClientStream(createRequest(), {
          onHeader(header_) {
            header = header_;
          },
          onTrailer(trailer_) {
            trailer = trailer_;
          },
        });
      } catch (err) {
        error = err;
      }

      expect(error).toEqual(
        new ClientError(
          '/nice_grpc.test.Test/TestClientStream',
          Status.NOT_FOUND,
          'test-1',
        ),
      );

      expect(header?.get('test')).toEqual('test-header');
      expect(trailer?.get('test')).toEqual('test-trailer');
    });

    if (
      process.env.FORCE_ALL_TESTS !== 'true' &&
      (transport === 'fetch' ||
        (proxyType === 'grpcwebproxy' && transport !== 'websocket') ||
        proxyType === 'traefik')
    ) {
      // full duplex is not supported by fetch
      // grpcwebproxy and traefik do not send response before request is finished
    } else {
      it('receives a response before finishing sending request', async () => {
        const client = await init({
          async testClientStream() {
            return {id: 'test'};
          },
        });

        const requestIterableFinish = defer<void>();

        async function* createRequest() {
          await requestIterableFinish.promise;
        }

        expect(await client.testClientStream(createRequest())).toEqual({
          id: 'test',
        });

        requestIterableFinish.resolve();
      });

      it('stops reading request iterable on response', async () => {
        const client = await init({
          async testClientStream() {
            return {id: 'test'};
          },
        });

        const responseFinish = defer<void>();

        let continuedReading = false;

        async function* createRequest() {
          await responseFinish.promise;

          yield {id: 'test'};

          continuedReading = true;
        }

        expect(await client.testClientStream(createRequest())).toEqual({
          id: 'test',
        });

        responseFinish.resolve();

        expect(continuedReading).toEqual(false);
      });
    }

    it('cancels a call', async () => {
      const serverRequestStartDeferred = defer<void>();
      const serverAbortDeferred = defer<void>();

      const client = await init({
        async testClientStream(request, {signal}) {
          serverRequestStartDeferred.resolve();

          try {
            return await forever(signal);
          } catch (err) {
            if (isAbortError(err)) {
              serverAbortDeferred.resolve();
            }

            throw err;
          }
        },
      });

      const abortController = new AbortController();

      const requestIterableFinish = defer<void>();

      async function* createRequest() {
        // fetch may not send request until the first request is sent
        yield {id: 'test'};

        await requestIterableFinish.promise;
      }

      await Promise.all([
        Promise.resolve().then(async () => {
          let error: unknown;

          try {
            await client.testClientStream(createRequest(), {
              signal: abortController.signal,
            });
          } catch (err) {
            error = err;
          }

          expect(isAbortError(error)).toBe(true);
          requestIterableFinish.resolve();

          await serverAbortDeferred.promise;
        }),
        Promise.resolve().then(async () => {
          await serverRequestStartDeferred.promise;

          abortController.abort();
        }),
      ]);
    });

    it('handles request iterable error', async () => {
      const serverRequestStartDeferred = defer<void>();

      const client = await init({
        async testClientStream(request) {
          for await (const _ of request) {
            serverRequestStartDeferred.resolve();
          }
          return {};
        },
      });

      async function* createRequest() {
        yield {id: 'test-1'};

        await serverRequestStartDeferred.promise;

        throw new Error('test');
      }

      let error: unknown;

      try {
        await client.testClientStream(createRequest());
      } catch (err) {
        error = err;
      }

      expect(error).toEqual(new Error('test'));
    });

    if (
      process.env.FORCE_ALL_TESTS !== 'true' &&
      (environment?.name === 'chrome' ||
        environment?.name === 'safari' ||
        environment?.name === 'ios' ||
        environment?.name === 'edge-chromium' ||
        environment?.name === 'firefox') &&
      transport === 'fetch'
    ) {
      // most browsers only receive headers after the first message is sent
    } else {
      it('receives early header', async () => {
        const endDeferred = defer();

        const client = await init({
          async testClientStream(request, context) {
            context.header.set('test', 'test-value');
            context.sendHeader();

            await endDeferred.promise;

            const requests: TestRequest[] = [];

            for await (const req of request) {
              requests.push(req);
            }

            return {
              id: requests.map(request => request.id).join(' '),
            };
          },
        });

        const headerDeferred = defer<Metadata>();

        async function* createRequest() {
          yield {id: 'test-1'};
          yield {id: 'test-2'};
        }

        await Promise.all([
          Promise.resolve().then(async () => {
            expect((await headerDeferred.promise).get('test')).toEqual(
              'test-value',
            );
            endDeferred.resolve();
          }),
          Promise.resolve().then(async () => {
            expect(
              await client.testClientStream(createRequest(), {
                onHeader(header) {
                  headerDeferred.resolve(header);
                },
              }),
            ).toEqual({id: 'test-1 test-2'});
          }),
        ]);
      });
    }
  });
});
