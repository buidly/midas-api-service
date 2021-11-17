import { CallHandler, ExecutionContext, HttpException, Injectable, NestInterceptor } from "@nestjs/common";
import { HttpAdapterHost } from "@nestjs/core";
import { Observable, of, throwError } from "rxjs";
import { catchError, tap } from 'rxjs/operators';
import { MetricsService } from "src/common/metrics/metrics.service";
import { CachingService } from "src/common/caching/caching.service";
import { ProtocolService } from "src/common/protocol/protocol.service";

@Injectable()
export class CachingInterceptor implements NestInterceptor {
  private pendingRequestsDictionary: { [ key: string]: any; } = {};

  constructor(
    private readonly cachingService: CachingService,
    private readonly httpAdapterHost: HttpAdapterHost,
    private readonly metricsService: MetricsService,
    private readonly protocolService: ProtocolService,
  ) {}

  async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<any>> {
    let apiFunction = context.getClass().name + '.' + context.getHandler().name;

    this.metricsService.setPendingRequestsCount(Object.keys(this.pendingRequestsDictionary).length);

    let cacheKey = this.getCacheKey(context);
    if (cacheKey) {
      let pendingRequest = this.pendingRequestsDictionary[cacheKey];
      if (pendingRequest) {
        let result = await pendingRequest;
        this.metricsService.incrementPendingApiHit(apiFunction);

        if (result instanceof HttpException) {
          return throwError(() => result);
        } else {
          return of(result);
        }
      }

      let cachedValue = await this.cachingService.getCacheLocal(cacheKey);
      if (cachedValue) {
        this.metricsService.incrementCachedApiHit(apiFunction);
        return of(cachedValue);
      }

      let pendingRequestResolver: (value: any) => null;
      this.pendingRequestsDictionary[cacheKey] = new Promise((resolve) => {
        // @ts-ignore
        pendingRequestResolver = resolve;
      });

      return next
        .handle()
        .pipe(
          tap(async (result: any) => {
            delete this.pendingRequestsDictionary[cacheKey ?? ''];
            pendingRequestResolver(result);
            this.metricsService.setPendingRequestsCount(Object.keys(this.pendingRequestsDictionary).length);
    
            let ttl = await this.protocolService.getSecondsRemainingUntilNextRound();
    
            await this.cachingService.setCacheLocal(cacheKey!!, result, ttl);
          }),
          catchError((err) => {
            delete this.pendingRequestsDictionary[cacheKey ?? ''];
            pendingRequestResolver(err);
            this.metricsService.setPendingRequestsCount(Object.keys(this.pendingRequestsDictionary).length);

            return throwError(() => err);
          })
        );
    }

    return next.handle();
  }

  getCacheKey(context: ExecutionContext): string | undefined {
      const httpAdapter = this.httpAdapterHost.httpAdapter;

      const request = context.getArgByIndex(0);
      if (httpAdapter.getRequestMethod(request) !== 'GET') {
          return undefined;
      }

      return httpAdapter.getRequestUrl(request);
  }
}