#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';

import { resolveConfig, haPostureFor, ResolvedConfig } from '../lib/config';
import { NetworkStack } from '../lib/network-stack';
import { ClusterStack } from '../lib/cluster-stack';
import { DataStack } from '../lib/data-stack';
import { PlatformStack } from '../lib/platform-stack';

/**
 * Stage containing one full deployment (Network + Cluster + Data + Platform).
 *
 * Using cdk.Stage so the same code can deploy multiple environments
 * (`Dev` and `Prod`, or `us-west-2` and `eu-west-1`) without duplicated
 * stack code. Stack logical IDs are namespaced by the Stage name.
 */
class LlmSafeSpacesStage extends cdk.Stage {
  constructor(scope: Construct, id: string, config: ResolvedConfig) {
    super(scope, id, {
      env: { account: config.account, region: config.region },
    });

    const ha = haPostureFor(config.tier);
    const tags = {
      project: 'llmsafespaces',
      tier: config.tier,
      'managed-by': 'cdk',
    };

    const network = new NetworkStack(this, 'Network', { tags, ha });

    const cluster = new ClusterStack(this, 'Cluster', {
      tags,
      vpc: network.vpc,
      ha,
      adminRoleArn: config.adminRoleArn,
      nodeInstanceTypes: config.nodeInstanceTypes,
      nodeSpot: config.nodeSpot,
      displayRegion: config.region,
      awsProfile: config.awsProfile,
      opsRepoUrl: config.opsRepoUrl,
      opsRepoBranch: config.opsRepoBranch,
    });

    const data = new DataStack(this, 'Data', {
      tags,
      vpc: network.vpc,
      clusterSecurityGroup: cluster.clusterSecurityGroup,
      ha,
      valkeyTls: config.valkeyTls,
    });

    new PlatformStack(this, 'Platform', {
      tags,
      cluster: cluster.cluster,
      postgresSecret: data.postgresSecret,
      valkeyAuthSecret: data.valkeyAuthSecret,
      postgresEndpoint: data.postgres.dbInstanceEndpointAddress,
      valkeyEndpoint: data.valkey.attrPrimaryEndPointAddress,
      hostname: config.hostname,
      externalSecretsRoleArn: cluster.externalSecretsRole.roleArn,
      imageRefs: config.imageRefs,
    });
  }
}

const app = new cdk.App();

// Resolve config from CDK context — single source of truth for all
// stack inputs. See lib/config.ts for the schema and cdk.context.example.json
// for the operator-facing config.
const config = resolveConfig(app);

// Stage name controls the logical-ID prefix in CFN. Default 'LlmSafeSpaces'
// preserves the existing stack names (`LlmSafeSpaces-Network`,
// `LlmSafeSpaces-Cluster`, ...) so an existing deploy can `cdk diff` cleanly.
// Override via -c stage=Dev for a second environment.
const stageName = app.node.tryGetContext('stage') ?? 'LlmSafeSpaces';
new LlmSafeSpacesStage(app, stageName, config);

app.synth();
