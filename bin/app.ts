#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { NetworkStack } from '../lib/network-stack';
import { ClusterStack } from '../lib/cluster-stack';
import { DataStack } from '../lib/data-stack';
import { PlatformStack } from '../lib/platform-stack';

const app = new cdk.App();

const env: cdk.Environment = {
  account: '572169125554',
  region: 'us-west-2',
};

const tags = {
  project: 'llmsafespaces',
  owner: 'mikekao',
  ManagedBy: 'cdk',
};

// 1. VPC, subnets, NAT
const network = new NetworkStack(app, 'LlmSafeSpaces-Network', { env, tags });

// 2. EKS cluster + node group + add-ons (EBS CSI, ALB controller, cert-manager)
const cluster = new ClusterStack(app, 'LlmSafeSpaces-Cluster', {
  env,
  tags,
  vpc: network.vpc,
});

// 3. RDS Postgres + ElastiCache Valkey, security groups wired to cluster
const data = new DataStack(app, 'LlmSafeSpaces-Data', {
  env,
  tags,
  vpc: network.vpc,
  clusterSecurityGroup: cluster.clusterSecurityGroup,
});

// 4. ACM cert + Helm release of the chart
new PlatformStack(app, 'LlmSafeSpaces-Platform', {
  env,
  tags,
  cluster: cluster.cluster,
  postgres: data.postgres,
  postgresSecret: data.postgresSecret,
  valkey: data.valkey,
  valkeyAuthSecret: data.valkeyAuthSecret,
  hostname: 'safespaces.thekao.cloud',
});

app.synth();
