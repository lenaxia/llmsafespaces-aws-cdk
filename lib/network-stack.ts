import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { Construct } from 'constructs';

import { HaPosture } from './config';

export interface NetworkStackProps extends cdk.StackProps {
  /** HA posture (drives NAT count). */
  readonly ha: HaPosture;
}

/**
 * VPC with 2 AZs (EKS requirement) and tier-driven NAT redundancy.
 *
 * The 1-NAT MVP saves ~$33/mo vs 2 NATs at the cost of AZ-level
 * availability if the NAT's AZ fails. The prod tier flips to 2 NATs.
 */
export class NetworkStack extends cdk.Stack {
  public readonly vpc: ec2.Vpc;

  constructor(scope: Construct, id: string, props: NetworkStackProps) {
    super(scope, id, props);

    this.vpc = new ec2.Vpc(this, 'Vpc', {
      maxAzs: 2,
      natGateways: props.ha.natGatewayCount,
      ipAddresses: ec2.IpAddresses.cidr('10.42.0.0/16'),
      subnetConfiguration: [
        { cidrMask: 24, name: 'public', subnetType: ec2.SubnetType.PUBLIC },
        { cidrMask: 22, name: 'private', subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
        { cidrMask: 24, name: 'isolated', subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      ],
    });

    // Subnet tags required by AWS Load Balancer Controller for ALB
    // subnet auto-discovery. Without them, the controller can't pick
    // which subnets to attach to.
    for (const subnet of this.vpc.publicSubnets) {
      cdk.Tags.of(subnet).add('kubernetes.io/role/elb', '1');
    }
    for (const subnet of this.vpc.privateSubnets) {
      cdk.Tags.of(subnet).add('kubernetes.io/role/internal-elb', '1');
    }
  }
}
