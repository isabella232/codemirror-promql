// The MIT License (MIT)
//
// Copyright (c) 2020 The Prometheus Authors
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.

import { FetchFn } from '.';

const apiPrefix = '/api/v1';
const labelsEndpoint = apiPrefix + '/labels';
const labelValuesEndpoint = apiPrefix + '/label/:name/values';
const seriesEndpoint = apiPrefix + '/series';
const metricMetadataEndpoint = apiPrefix + '/metadata';

export interface MetricMetadata {
  type: string;
  help: string;
}

export interface PrometheusClient {
  labelNames(metricName?: string): Promise<string[]>;

  // labelValues return a list of the value associated to the given labelName.
  // In case a metric is provided, then the list of values is then associated to the couple <MetricName, LabelName>
  labelValues(labelName: string, metricName?: string): Promise<string[]>;

  metricMetadata(): Promise<Record<string, MetricMetadata[]>>;

  series(metricName: string): Promise<Map<string, string>[]>;
}

interface APIResponse<T> {
  status: 'success' | 'error';
  data?: T;
  error?: string;
  warnings?: string[];
}

// These are status codes where the Prometheus API still returns a valid JSON body,
// with an error encoded within the JSON.
const badRequest = 400;
const unprocessableEntity = 422;
const serviceUnavailable = 503;

function buildAssociations(metricName: string, series: Map<string, string>[], completeAssociation: Map<string, Map<string, Set<string>>>) {
  series.forEach((labelSet: Map<string, string>) => {
    let currentAssociation = completeAssociation.get(metricName);
    if (!currentAssociation) {
      currentAssociation = new Map<string, Set<string>>();
      completeAssociation.set(metricName, currentAssociation);
    }

    for (const [key, value] of Object.entries(labelSet)) {
      if (key === '__name__') {
        continue;
      }
      const labelValues = currentAssociation.get(key);
      if (labelValues === undefined) {
        currentAssociation.set(
          key,
          new Set<string>([value])
        );
      } else {
        labelValues.add(value);
      }
    }
  });
}

// HTTPPrometheusClient is the HTTP client that should be used to get some information from the different endpoint provided by prometheus.
export class HTTPPrometheusClient implements PrometheusClient {
  private readonly lookbackInterval = 60 * 60 * 1000 * 12; //12 hours
  private readonly url: string;
  private readonly errorHandler?: (error: any) => void;
  // For some reason, just assigning via "= fetch" here does not end up executing fetch correctly
  // when calling it, thus the indirection via another function wrapper.
  private readonly fetchFn: FetchFn = (input: RequestInfo, init?: RequestInit): Promise<Response> => fetch(input, init);

  constructor(url: string, errorHandler?: (error: any) => void, lookbackInterval?: number, fetchFn?: FetchFn) {
    this.url = url;
    this.errorHandler = errorHandler;
    if (lookbackInterval) {
      this.lookbackInterval = lookbackInterval;
    }
    if (fetchFn) {
      this.fetchFn = fetchFn;
    }
  }

  labelNames(metricName?: string): Promise<string[]> {
    const end = new Date();
    const start = new Date(end.getTime() - this.lookbackInterval);
    if (metricName === undefined || metricName === '') {
      const params: URLSearchParams = new URLSearchParams({
        start: start.toISOString(),
        end: end.toISOString(),
      });
      // See https://prometheus.io/docs/prometheus/latest/querying/api/#getting-label-names
      return this.fetchAPI<string[]>(`${labelsEndpoint}?${params}`).catch((error) => {
        if (this.errorHandler) {
          this.errorHandler(error);
        }
        return [];
      });
    }

    return this.series(metricName).then((series) => {
      const labelNames = new Set<string>();
      for (const labelSet of series) {
        for (const [key] of Object.entries(labelSet)) {
          if (key === '__name__') {
            continue;
          }
          labelNames.add(key);
        }
      }
      return Array.from(labelNames);
    });
  }

  // labelValues return a list of the value associated to the given labelName.
  // In case a metric is provided, then the list of values is then associated to the couple <MetricName, LabelName>
  labelValues(labelName: string, metricName?: string): Promise<string[]> {
    const end = new Date();
    const start = new Date(end.getTime() - this.lookbackInterval);

    if (!metricName || metricName.length === 0) {
      const params: URLSearchParams = new URLSearchParams({
        start: start.toISOString(),
        end: end.toISOString(),
      });
      // See https://prometheus.io/docs/prometheus/latest/querying/api/#querying-label-values
      return this.fetchAPI<string[]>(`${labelValuesEndpoint.replace(/:name/gi, labelName)}?${params}`).catch((error) => {
        if (this.errorHandler) {
          this.errorHandler(error);
        }
        return [];
      });
    }

    return this.series(metricName).then((series) => {
      const labelValues = new Set<string>();
      for (const labelSet of series) {
        for (const [key, value] of Object.entries(labelSet)) {
          if (key === '__name__') {
            continue;
          }
          if (key === labelName) {
            labelValues.add(value);
          }
        }
      }
      return Array.from(labelValues);
    });
  }

  metricMetadata(): Promise<Record<string, MetricMetadata[]>> {
    return this.fetchAPI<Record<string, MetricMetadata[]>>(metricMetadataEndpoint).catch((error) => {
      if (this.errorHandler) {
        this.errorHandler(error);
      }
      return {};
    });
  }

  series(metricName: string): Promise<Map<string, string>[]> {
    const end = new Date();
    const start = new Date(end.getTime() - this.lookbackInterval);
    const params: URLSearchParams = new URLSearchParams({
      start: start.toISOString(),
      end: end.toISOString(),
      'match[]': metricName,
    });
    // See https://prometheus.io/docs/prometheus/latest/querying/api/#finding-series-by-label-matchers
    return this.fetchAPI<Map<string, string>[]>(`${seriesEndpoint}?${params}`).catch((error) => {
      if (this.errorHandler) {
        this.errorHandler(error);
      }
      return [];
    });
  }

  private fetchAPI<T>(resource: string): Promise<T> {
    return this.fetchFn(this.url + resource)
      .then((res) => {
        if (!res.ok && ![badRequest, unprocessableEntity, serviceUnavailable].includes(res.status)) {
          throw new Error(res.statusText);
        }
        return res;
      })
      .then((res) => res.json())
      .then((apiRes: APIResponse<T>) => {
        if (apiRes.status === 'error') {
          throw new Error(apiRes.error !== undefined ? apiRes.error : 'missing "error" field in response JSON');
        }
        if (apiRes.data === undefined) {
          throw new Error('missing "data" field in response JSON');
        }
        return apiRes.data;
      });
  }
}

class Cache {
  // completeAssociation is the association between a metric name, a label name and the possible label values
  private readonly completeAssociation: Map<string, Map<string, Set<string>>>;
  // metricMetadata is the association between a metric name and the associated metadata
  private metricMetadata: Record<string, MetricMetadata[]>;
  private labelValues: Map<string, string[]>;
  private labelNames: string[];

  constructor() {
    this.completeAssociation = new Map<string, Map<string, Set<string>>>();
    this.metricMetadata = {};
    this.labelValues = new Map<string, string[]>();
    this.labelNames = [];
  }

  setAssociations(metricName: string, series: Map<string, string>[]): void {
    buildAssociations(metricName, series, this.completeAssociation);
  }

  setMetricMetadata(metadata: Record<string, MetricMetadata[]>): void {
    this.metricMetadata = metadata;
  }

  getMetricMetadata(): Record<string, MetricMetadata[]> {
    return this.metricMetadata;
  }

  setLabelNames(labelNames: string[]): void {
    this.labelNames = labelNames;
  }

  getLabelNames(metricName?: string): string[] {
    if (!metricName || metricName.length === 0) {
      return this.labelNames;
    }
    const labelSet = this.completeAssociation.get(metricName);
    return labelSet ? Array.from(labelSet.keys()) : [];
  }

  setLabelValues(labelName: string, labelValues: string[]): void {
    this.labelValues.set(labelName, labelValues);
  }

  getLabelValues(labelName: string, metricName?: string): string[] {
    if (!metricName || metricName.length === 0) {
      const result = this.labelValues.get(labelName);
      return result ? result : [];
    }

    const labelSet = this.completeAssociation.get(metricName);
    if (labelSet) {
      const labelValues = labelSet.get(labelName);
      return labelValues ? Array.from(labelValues) : [];
    }
    return [];
  }
}

export class CachedPrometheusClient implements PrometheusClient {
  private readonly cache: Cache;
  private readonly client: PrometheusClient;

  constructor(client: PrometheusClient) {
    this.client = client;
    this.cache = new Cache();
  }

  labelNames(metricName?: string): Promise<string[]> {
    const cachedLabel = this.cache.getLabelNames(metricName);
    if (cachedLabel && cachedLabel.length > 0) {
      return Promise.resolve(cachedLabel);
    }

    if (metricName === undefined || metricName === '') {
      return this.client.labelNames().then((labelNames) => {
        this.cache.setLabelNames(labelNames);
        return labelNames;
      });
    }
    return this.series(metricName).then(() => {
      return this.cache.getLabelNames(metricName);
    });
  }

  labelValues(labelName: string, metricName?: string): Promise<string[]> {
    const cachedLabel = this.cache.getLabelValues(labelName, metricName);
    if (cachedLabel && cachedLabel.length > 0) {
      return Promise.resolve(cachedLabel);
    }

    if (metricName === undefined || metricName === '') {
      return this.client.labelValues(labelName).then((labelValues) => {
        this.cache.setLabelValues(labelName, labelValues);
        return labelValues;
      });
    }

    return this.series(metricName).then(() => {
      return this.cache.getLabelValues(labelName, metricName);
    });
  }

  metricMetadata(): Promise<Record<string, MetricMetadata[]>> {
    const cachedMetadata = this.cache.getMetricMetadata();
    if (cachedMetadata && Object.keys(cachedMetadata).length > 0) {
      return Promise.resolve(cachedMetadata);
    }

    return this.client.metricMetadata().then((metadata) => {
      this.cache.setMetricMetadata(metadata);
      return this.cache.getMetricMetadata();
    });
  }

  series(metricName: string): Promise<Map<string, string>[]> {
    return this.client.series(metricName).then((series) => {
      this.cache.setAssociations(metricName, series);
      return series;
    });
  }
}
