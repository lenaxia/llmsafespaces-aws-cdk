import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { Construct } from 'constructs';

export interface NetworkStackProps extends cdk.StackProps {
  tags?: Record<string, string>;
}

/**
 * VPC with 2 AZs (EKS hard requirement) and a SINGLE NAT Gateway
 * in one AZ to keep costs down (~$33/mo saved vs. 2 NATs).
 *
 * Trade-off: if the AZ holding the NAT loses connectivity, pods in the
 * other AZ can't reach internet (LLM providers, GHCR). Acceptable for
 * MVP; flip to natGateways: 2 for production.
 */
export class NetworkStack extends cdk.Stack {
  public readonly vpc: ec2.Vpc;

  constructor(scope: Construct, id: string, props: NetworkStackProps) {
    super(scope, id, props);

    this.vpc = new ec2.Vpc(this, 'Vpc', {
      maxAzs: 2,
      natGateways: 1,
      ipAddresses: ec2.IpAddresses.cidr('10.42.0.0/16'),
      subnetConfiguration: [
        {
          cidrMask: 24,
          name: 'public',
          subnetType: ec2.SubnetType.PUBLIC,
        },
        {
          cidrMask: 22,
          name: 'private',
          subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
        },
        {
          cidrMask: 24,
          name: 'isolated',
          subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
        },
      ],
    });

    // Subnet tags required by the AWS Load Balancer Controller for auto-discovery.
    // Without these, alb-ingress can't pick which subnets to attach the ALB to.
    for (const subnet of this.vpc.publicSubnets) {
      cdk.Tags.of(subnet).add('kubernetes.io/role/elb', '1');
    }
    for (const subnet of this.vpc.privateSubnets) {
      cdk.Tags.of(subnet).add('kubernetes.io/role/internal-elb', '1');
    }
  }
}
